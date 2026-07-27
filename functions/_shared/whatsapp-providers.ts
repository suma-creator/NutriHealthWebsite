// supabase/functions/_shared/whatsapp-providers.ts

const INSTANCE_ID = Deno.env.get("GREEN_API_INSTANCE_ID");
const API_TOKEN = Deno.env.get("GREEN_API_TOKEN");

// Use your instance's API URL.
// If your dashboard shows 7107.api.greenapi.com, keep that.
// Otherwise replace 7107 with your assigned host.
const BASE_URL = `https://7107.api.greenapi.com/waInstance${INSTANCE_ID}`;

export async function sendGreenApiMessage(
  phoneNumber: string,
  message: string,
) {
  if (!INSTANCE_ID || !API_TOKEN) {
    throw new Error(
      "Missing GREEN_API_INSTANCE_ID or GREEN_API_TOKEN environment variables.",
    );
  }

  // Remove everything except digits
  const formattedNumber = phoneNumber.replace(/\D/g, "");

  // Green API chat ID format
  const chatId = `${formattedNumber}@c.us`;

  const url = `${BASE_URL}/sendMessage/${API_TOKEN}`;

  console.log("========== GREEN API ==========");
  console.log("URL:", url);
  console.log("Chat ID:", chatId);
  console.log("Message:", message);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chatId,
      message,
    }),
  });

  console.log("HTTP Status:", response.status);

  const responseText = await response.text();

  console.log("Response:", responseText);

  if (!response.ok) {
    throw new Error(
      `Green API Request Failed (${response.status}): ${responseText}`,
    );
  }

  return JSON.parse(responseText);
}