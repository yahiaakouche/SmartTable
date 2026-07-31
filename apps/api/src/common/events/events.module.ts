import { Global, Module } from '@nestjs/common';
import { DomainEventsService } from './domain-events.service';

/**
 * Internal event bus — global like the database connection: every domain
 * module may inject DomainEventsService without importing anything, and the
 * future Socket.IO gateway will subscribe to the same single instance.
 */
@Global()
@Module({
  providers: [DomainEventsService],
  exports: [DomainEventsService],
})
export class EventsModule {}
