import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { CreateAvailabilityBlockDto } from './dto/availability.dto';

@Injectable()
export class AvailabilityService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // Get upcoming availability blocks for an artist (public)
  // ----------------------------------------------------------------
  async getByArtistUserId(artistUserId: string) {
    return this.db('availability_blocks')
      .where({ artist_id: artistUserId })
      .where('end_date', '>=', this.db.raw('CURRENT_DATE'))
      .orderBy('start_date', 'asc')
      .select('id', 'start_date', 'end_date', 'note');
  }

  // ----------------------------------------------------------------
  // Create a block (artist only)
  // ----------------------------------------------------------------
  async create(artistUserId: string, dto: CreateAvailabilityBlockDto) {
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('end_date must be on or after start_date.');
    }

    // Prevent creating blocks in the past
    const today = new Date().toISOString().split('T')[0];
    if (dto.endDate < today) {
      throw new BadRequestException('Cannot create availability blocks in the past.');
    }

    const [row] = await this.db('availability_blocks')
      .insert({
        artist_id:  artistUserId,
        start_date: dto.startDate,
        end_date:   dto.endDate,
        note:       dto.note ?? null,
      })
      .returning('*');

    return row;
  }

  // ----------------------------------------------------------------
  // Delete a block (artist can only delete their own)
  // ----------------------------------------------------------------
  async remove(artistUserId: string, blockId: string) {
    const block = await this.db('availability_blocks').where({ id: blockId }).first();
    if (!block) throw new NotFoundException('Availability block not found.');
    if (block.artist_id !== artistUserId) throw new ForbiddenException('Not your availability block.');

    await this.db('availability_blocks').where({ id: blockId }).delete();
    return { message: 'Availability block removed.' };
  }
}
