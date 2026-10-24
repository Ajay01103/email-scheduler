import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config, logger } from './config.js';
import { endpointAddress, errorDetails } from './dependency-errors.js';

export const QUEUE_NAME = 'email-delivery';
export interface EmailJob { emailId: string; generation: number }
export const queueRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
queueRedis.on('error', (error) => logger.error({ ...errorDetails(error), endpoint: endpointAddress(config.REDIS_URL) }, 'Queue Redis connection error')); 
export const emailQueue = new Queue<EmailJob>(QUEUE_NAME, {
  connection: queueRedis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 86400, count: 10000 },
    removeOnFail: { age: 604800, count: 10000 },
  },
});
emailQueue.on('error', (error) => logger.error(errorDetails(error), 'Email queue error'));
export function emailJobId(emailId: string, generation: number): string {
  return `${emailId}-${generation}`;
}
