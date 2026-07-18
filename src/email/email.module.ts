import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

@Global() // available everywhere without re-importing, same pattern as RedisModule
@Module({
  providers: [EmailService],
  exports:   [EmailService],
})
export class EmailModule {}
