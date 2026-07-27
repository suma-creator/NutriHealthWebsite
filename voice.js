/* =========================================================================
   voice.js — shared voice chat helper (speech-to-text + text-to-speech)
   used by both AI chat surfaces: the main AI Chatbot (chatbot.js) and the
   AI Symptom Chat panel (symptoms.js). Loaded on both chatbot.html and
   symptoms.html, right before the page-specific script.

   Browser support: Web Speech API (SpeechRecognition for input,
   speechSynthesis for output). Both are optional progressive enhancements
   — if a browser doesn't support one or both, the relevant buttons are
   simply hidden rather than breaking the chat.
   ========================================================================= */

const VoiceHelper = (() => {
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const synth = window.speechSynthesis || null;

  function isRecognitionSupported() {
    return Boolean(RecognitionCtor);
  }

  function isSynthesisSupported() {
    return Boolean(synth);
  }

  /**
   * Wires a mic button to fill a text input with spoken words.
   * @param {HTMLElement} button - the mic button to toggle listening.
   * @param {HTMLInputElement|HTMLTextAreaElement} inputEl - target field.
   * @param {Object} opts - { onTranscript(text), onStart(), onEnd(), lang }
   */
  function attachMic(button, inputEl, opts = {}) {
    if (!button) return null;

    if (!isRecognitionSupported()) {
      button.style.display = "none";
      return null;
    }

    const recognition = new RecognitionCtor();
    recognition.lang = opts.lang || "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    let listening = false;
    let finalTranscript = "";

    function setListening(state) {
      listening = state;
      button.classList.toggle("listening", state);
      button.setAttribute("aria-label", state ? "Stop voice input" : "Start voice input");
      button.textContent = state ? "⏹️" : "🎤";
    }

    setListening(false);

    recognition.onstart = () => {
      finalTranscript = "";
      opts.onStart?.();
    };

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += chunk;
        else interim += chunk;
      }
      if (inputEl) inputEl.value = (finalTranscript + interim).trim();
    };

    recognition.onerror = (event) => {
      console.warn("Speech recognition error:", event.error);
      setListening(false);
      opts.onError?.(event.error);
    };

    recognition.onend = () => {
      setListening(false);
      opts.onEnd?.(finalTranscript.trim());
    };

    button.addEventListener("click", () => {
      if (listening) {
        recognition.stop();
        return;
      }
      // If the AI is currently talking, this tap's only job is to stop
      // it — don't also start listening in the same tap, since the
      // tail end of the speech audio can otherwise get picked up as
      // noise. Tap again afterwards to start speaking your question.
      if (isSpeaking()) {
        stopSpeaking();
        button.classList.add("mic-interrupt-flash");
        setTimeout(() => button.classList.remove("mic-interrupt-flash"), 300);
        return;
      }
      try {
        recognition.start();
        setListening(true);
      } catch (err) {
        console.warn("Couldn't start speech recognition:", err);
      }
    });

    return recognition;
  }

  let currentUtterance = null;
  let activeSpeakButton = null;
  let speakStateListeners = [];

  function notifySpeakState() {
    const speaking = isSpeaking();
    speakStateListeners.forEach((fn) => {
      try { fn(speaking); } catch (err) { console.warn("Speak-state listener failed:", err); }
    });
  }

  /**
   * Subscribe to speaking start/stop. Callback receives `true` when speech
   * starts and `false` when it stops (naturally or via stopSpeaking()).
   * Used to show/hide an always-visible "Stop talking" control. Returns an
   * unsubscribe function.
   */
  function onSpeakStateChange(callback) {
    speakStateListeners.push(callback);
    return () => { speakStateListeners = speakStateListeners.filter((fn) => fn !== callback); };
  }

  function resetSpeakButton(button) {
    if (!button) return;
    button.textContent = "🔊 Listen";
    button.classList.remove("speaking");
  }

  function speak(text, opts = {}) {
    if (!isSynthesisSupported() || !text) return;
    stopSpeaking();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = opts.rate || 1;
    utterance.pitch = opts.pitch || 1;
    utterance.lang = opts.lang || "en-US";
    utterance.onstart = () => { notifySpeakState(); opts.onStart?.(); };
    utterance.onend = () => { currentUtterance = null; notifySpeakState(); opts.onEnd?.(); };
    utterance.onerror = () => { currentUtterance = null; notifySpeakState(); opts.onEnd?.(); };

    currentUtterance = utterance;
    synth.speak(utterance);
  }

  function stopSpeaking() {
    const wasSpeaking = isSpeaking();
    if (synth && synth.speaking) synth.cancel();
    currentUtterance = null;
    if (activeSpeakButton) {
      resetSpeakButton(activeSpeakButton);
      activeSpeakButton = null;
    }
    if (wasSpeaking) notifySpeakState();
  }

  function isSpeaking() {
    return Boolean(synth && synth.speaking);
  }

  /**
   * Speaks `text` and manages a per-message button's label/state so the
   * person can tap it again — mid-sentence — to stop that reply immediately.
   * Only one message plays at a time; starting a new one auto-stops
   * whichever was playing (and resets its button).
   */
  function speakWithButton(text, button) {
    if (!isSynthesisSupported() || !button) return;

    // Tapping the button that's currently talking stops it — this is the
    // main "stop it from talking" control.
    if (activeSpeakButton === button && isSpeaking()) {
      stopSpeaking();
      return;
    }

    stopSpeaking(); // interrupt/reset whatever else was playing
    activeSpeakButton = button;
    button.textContent = "⏹️ Stop";
    button.classList.add("speaking");

    speak(text, {
      onEnd: () => {
        resetSpeakButton(button);
        if (activeSpeakButton === button) activeSpeakButton = null;
      }
    });
  }

  /**
   * Wires a header toggle button (🔊/🔇) that controls whether bot replies
   * are automatically read aloud. Persists the preference in localStorage
   * per-key so each chat surface can remember its own setting.
   */
  function attachAutoSpeakToggle(button, storageKey, opts = {}) {
    if (!button) return { isEnabled: () => false };

    if (!isSynthesisSupported()) {
      button.style.display = "none";
      return { isEnabled: () => false };
    }

    let enabled = localStorage.getItem(storageKey) === "1";

    function render() {
      button.classList.toggle("active", enabled);
      button.textContent = enabled ? "🔊" : "🔇";
      button.setAttribute("aria-label", enabled ? "Voice replies on — click to mute" : "Voice replies off — click to enable");
      button.title = enabled ? "Voice replies on" : "Voice replies off";
    }
    render();

    button.addEventListener("click", () => {
      enabled = !enabled;
      localStorage.setItem(storageKey, enabled ? "1" : "0");
      if (!enabled) stopSpeaking();
      render();
      opts.onChange?.(enabled);
    });

    return { isEnabled: () => enabled };
  }

  return {
    isRecognitionSupported,
    isSynthesisSupported,
    attachMic,
    speak,
    speakWithButton,
    stopSpeaking,
    isSpeaking,
    attachAutoSpeakToggle,
    onSpeakStateChange
  };
})();
