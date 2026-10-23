import { Client } from "@elastic/elasticsearch";
import { config } from "./config";

const indexName = "scheduled-emails";
export const searchClient = new Client({ node: config.ELASTICSEARCH_URL });

export async function indexEmail(email: {
  id: string;
  userId: string;
  recipient: string;
  sender: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
}) {
  await searchClient.index({
    index: indexName,
    id: email.id,
    document: {
      userId: email.userId,
      recipient: email.recipient,
      sender: email.sender,
      subject: email.subject,
      body: email.body,
      status: email.status,
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt
    },
    refresh: "wait_for"
  });
}

export async function indexEmails(emails: Array<{
  id: string;
  userId: string;
  recipient: string;
  sender: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
}>) {
  if (emails.length === 0) return;
  const operations = emails.flatMap((email) => [
    { index: { _index: indexName, _id: email.id } },
    {
      userId: email.userId,
      recipient: email.recipient,
      sender: email.sender,
      subject: email.subject,
      body: email.body,
      status: email.status,
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt
    }
  ]);
  const result = await searchClient.bulk({ operations, refresh: "wait_for" });
  if (result.errors) {
    const failures = result.items.filter((item) => item.index?.error).length;
    throw new Error(`Elasticsearch failed to index ${failures} email document(s)`);
  }
}

export async function searchEmails(userId: string, query: string) {
  const result = await searchClient.search({
    index: indexName,
    query: {
      bool: {
        filter: [{ term: { userId } }],
        must: [{ multi_match: { query, fields: ["recipient", "sender", "subject", "body"] } }]
      }
    },
    sort: [{ scheduledAt: "desc" }],
    size: 100
  });
  return result.hits.hits.map((hit) => hit._id).filter((id): id is string => Boolean(id));
}
