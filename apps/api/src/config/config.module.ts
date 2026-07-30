import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateAppConfig } from './app-config.schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Bootstrap values only come from environment/host-provided values written
      // by the Electron Host at launch — never a checked-in .env for a desktop product.
      validate: validateAppConfig,
    }),
  ],
})
export class ConfigModule {}
