import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as express from 'express';

async function bootstrap() {
  // Disable default bodyParser so we can capture rawBody buffer for signature checking
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  
  app.use(
    express.json({
      verify: (req: any, res: any, buf: any) => {
        req.rawBody = buf;
      },
    }),
  );
  
  app.use(
    express.urlencoded({
      extended: true,
      verify: (req: any, res: any, buf: any) => {
        req.rawBody = buf;
      },
    }),
  );

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = process.env.PORT || 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`payment-orchestrator listening on :${port}`);
}
bootstrap();
