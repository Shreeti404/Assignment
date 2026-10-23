import { prisma } from "./db";
import { decryptToken } from "./tokenCrypto";

export async function notifyRateLimit(userId: string, sender: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { slackToken: true, slackUserId: true }
  });
  if (!user?.slackToken || !user.slackUserId) return;

  const token = decryptToken(user.slackToken);
  const openResponse = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ users: user.slackUserId })
  });
  const conversation = await openResponse.json() as {
    ok: boolean;
    error?: string;
    channel?: { id: string };
  };
  if (!conversation.ok || !conversation.channel?.id) {
    throw new Error(`Slack could not open a notification channel: ${conversation.error ?? "unknown error"}`);
  }

  const messageResponse = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel: conversation.channel.id,
      text: `Email sending for ${sender} has reached its hourly limit. Remaining messages have been rescheduled.`
    })
  });
  const message = await messageResponse.json() as { ok: boolean; error?: string };
  if (!message.ok) throw new Error(`Slack notification failed: ${message.error ?? "unknown error"}`);
}
