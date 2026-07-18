import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { SearchPlannersDto, UpdatePlannerProfileDto } from './dto/planners.dto';

@Injectable()
export class PlannersService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // Search / list planners (public) — mirrors ArtistsService.search()
  // ----------------------------------------------------------------
  async search(dto: SearchPlannersDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    let query = this.db('planner_profiles as pp')
      .join('users as u', 'u.id', 'pp.user_id')
      .where('u.status', 'active')
      .select(
        'pp.id',
        'pp.user_id',
        'pp.display_name',
        'pp.company_name',
        'pp.bio',
        'pp.location_city',
        'pp.location_country',
        'pp.event_types',
        'pp.social_links',
        'pp.thumbnail_url',
        'pp.created_at',
      );

    // Filters
    if (dto.q) {
      query = query.whereRaw(
        `(pp.display_name ILIKE ? OR pp.company_name ILIKE ? OR pp.bio ILIKE ?)`,
        [`%${dto.q}%`, `%${dto.q}%`, `%${dto.q}%`],
      );
    }

    // Matches ANY planner whose event_types overlaps the requested list.
    // event_types is a JSONB array of strings (e.g. ["Wedding","Corporate"]);
    // ?| checks whether any of the given text[] values appear as elements.
    // Note: "?" is doubled to escape it from knex's own placeholder parsing.
    if (dto.eventTypes?.length) {
      query = query.whereRaw(`pp.event_types ??| ?::text[]`, [dto.eventTypes]);
    }

    if (dto.country) {
      query = query.whereILike('pp.location_country', dto.country);
    }

    if (dto.city) {
      query = query.whereILike('pp.location_city', dto.city);
    }

    // Sorting
    switch (dto.sort) {
      case 'name_asc': query = query.orderBy('pp.display_name', 'asc'); break;
      case 'newest':
      default:          query = query.orderBy('pp.created_at', 'desc');  break;
    }

    // Total count (same filters, no pagination)
    const countQuery = query.clone().clearSelect().clearOrder().count('pp.id as total').first();
    const [{ total }, rows] = await Promise.all([
      countQuery,
      query.limit(limit).offset(offset),
    ]);

    return {
      data: rows,
      meta: {
        total:   Number(total),
        page,
        limit,
        pages:   Math.ceil(Number(total) / limit),
      },
    };
  }

  // ----------------------------------------------------------------
  // Get public planner profile
  // ----------------------------------------------------------------
  async findOne(plannerProfileId: string) {
    const profile = await this.db('planner_profiles as pp')
      .join('users as u', 'u.id', 'pp.user_id')
      .where('pp.id', plannerProfileId)
      .where('u.status', 'active')
      .select(
        'pp.id',
        'pp.user_id',
        'pp.display_name',
        'pp.company_name',
        'pp.bio',
        'pp.location_city',
        'pp.location_country',
        'pp.event_types',
        'pp.social_links',
        'pp.thumbnail_url',
        'pp.created_at',
        'pp.avg_rating',
        'pp.review_count',
      )
      .first();

    if (!profile) throw new NotFoundException('Planner not found.');

    // Attach media — mirrors ArtistsService.findOne(). The media upload
    // endpoints (POST /media/*) were never role-restricted to artists, but
    // until now nothing ever queried a planner's media back out again.
    const media = await this.db('media')
      .where({ user_id: profile.user_id })
      .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'sort_order', order: 'asc' }])
      .select('id', 'media_type', 'cdn_url', 'duration_sec', 'is_primary', 'sort_order');

    return { ...profile, media };
  }

  // ----------------------------------------------------------------
  // Get own profile
  // ----------------------------------------------------------------
  async findMe(userId: string) {
    const profile = await this.db('planner_profiles')
      .where({ user_id: userId })
      .select('*', 'avg_rating', 'review_count')
      .first();

    if (!profile) throw new NotFoundException('Planner profile not found.');

    const media = await this.db('media')
      .where({ user_id: userId })
      .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'sort_order', order: 'asc' }])
      .select('id', 'media_type', 'cdn_url', 'file_size_bytes', 'duration_sec', 'is_primary', 'sort_order');

    return { ...profile, media };
  }

  // ----------------------------------------------------------------
  // Update own profile
  // ----------------------------------------------------------------
  async updateMe(userId: string, dto: UpdatePlannerProfileDto) {
    const profile = await this.db('planner_profiles').where({ user_id: userId }).first();
    if (!profile) throw new NotFoundException('Planner profile not found.');

    const patch: Record<string, any> = {};
    if (dto.displayName     !== undefined) patch.display_name     = dto.displayName;
    if (dto.companyName     !== undefined) patch.company_name     = dto.companyName;
    if (dto.bio             !== undefined) patch.bio              = dto.bio;
    if (dto.locationCity    !== undefined) patch.location_city    = dto.locationCity;
    if (dto.locationCountry !== undefined) patch.location_country = dto.locationCountry;
    if (dto.eventTypes      !== undefined) patch.event_types      = JSON.stringify(dto.eventTypes);
    if (dto.socialLinks     !== undefined) patch.social_links     = JSON.stringify(dto.socialLinks);

    if (Object.keys(patch).length === 0) return profile;

    const [updated] = await this.db('planner_profiles')
      .where({ user_id: userId })
      .update(patch)
      .returning('*');

    return updated;
  }
}
