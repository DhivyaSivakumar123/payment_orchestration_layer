import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: any;
  private isMockMode = false;
  private mockStore = new Map<string, string>();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);

    try {
      this.client = new Redis({
        host,
        port,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 1) {
            this.logger.warn(`Redis connection failed. Falling back to In-Memory store.`);
            this.isMockMode = true;
            return null; // Stop retrying
          }
          return 100;
        },
      });

      this.client.on('error', (err: any) => {
        this.logger.log(`Redis status check: ${err.message}. Running in fallback mode: ${this.isMockMode}`);
        this.isMockMode = true;
      });
    } catch (err: any) {
      this.logger.warn(`Could not instantiate Redis client: ${err.message}. Falling back to In-Memory store.`);
      this.isMockMode = true;
    }
  }

  onModuleDestroy() {
    if (this.client && !this.isMockMode) {
      this.client.disconnect();
    }
  }

  getClient(): any {
    if (this.isMockMode) {
      return {
        lpush: async (queue: string, item: string) => {
          this.mockStore.set(queue, item);
          return 1;
        },
        brpop: async (queue: string, timeout: number) => {
          const item = this.mockStore.get(queue);
          if (item) {
            this.mockStore.delete(queue);
            return [queue, item];
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          return null;
        },
        get: async (key: string) => this.mockStore.get(key) || null,
        set: async (key: string, value: string) => {
          this.mockStore.set(key, value);
          return 'OK';
        },
        del: async (key: string) => {
          const existed = this.mockStore.has(key);
          this.mockStore.delete(key);
          return existed ? 1 : 0;
        },
      };
    }
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    if (this.isMockMode) {
      return this.mockStore.get(key) || null;
    }
    try {
      return await this.client.get(key);
    } catch {
      this.isMockMode = true;
      return this.mockStore.get(key) || null;
    }
  }

  async set(
    key: string,
    value: string,
    mode?: 'NX' | 'XX',
    durationMode?: 'EX' | 'PX',
    duration?: number,
  ): Promise<'OK' | null> {
    if (this.isMockMode) {
      if (mode === 'NX' && this.mockStore.has(key)) {
        return null;
      }
      this.mockStore.set(key, value);
      return 'OK';
    }

    try {
      const client = this.client as any;
      if (mode && durationMode && duration !== undefined) {
        return await client.set(key, value, durationMode, duration, mode);
      }
      if (durationMode && duration !== undefined) {
        return await client.set(key, value, durationMode, duration);
      }
      return await client.set(key, value);
    } catch {
      this.isMockMode = true;
      if (mode === 'NX' && this.mockStore.has(key)) {
        return null;
      }
      this.mockStore.set(key, value);
      return 'OK';
    }
  }

  async del(key: string): Promise<number> {
    if (this.isMockMode) {
      const existed = this.mockStore.has(key);
      this.mockStore.delete(key);
      return existed ? 1 : 0;
    }
    try {
      return await this.client.del(key);
    } catch {
      this.isMockMode = true;
      const existed = this.mockStore.has(key);
      this.mockStore.delete(key);
      return existed ? 1 : 0;
    }
  }
}
