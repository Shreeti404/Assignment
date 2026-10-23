import { Queue } from "bullmq";
import { redis } from "./redis";

export const EMAIL_QUEUE = "scheduled-emails";

export interface EmailJob {
  emailId: string;
  sender: string;
  hourlyLimit: number;
}

export const emailQueue = new Queue<EmailJob>(EMAIL_QUEUE, {
  connection: redis
});
