// utils/modelRetry.ts
import { logger } from "firebase-functions";

export interface RetryConfig {
  maxRetries: number;
  delayMs: number;
  exponentialBackoff?: boolean;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  operationName: string
): Promise<T> {
  let attempts = 0;
  
  while (attempts < config.maxRetries) {
    try {
      return await operation();
    } catch (error: any) {
      attempts++;
      
      // Only retry on 503 (service unavailable)
      if (error.status !== 503 || attempts >= config.maxRetries) {
        throw error;
      }
      
      const delay = config.exponentialBackoff 
        ? config.delayMs * attempts 
        : config.delayMs;
        
      logger.warn(`[Retry] ${operationName} failed, retrying (${attempts}/${config.maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error(`All retries failed for ${operationName}`);
}