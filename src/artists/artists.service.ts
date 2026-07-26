import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { aggregateValue } from '../common/db.util';
import { SearchArtistsDto, UpdateArtistProfileDto } from './dto/artists.dto';

@Injectable()
export class ArtistsService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // Search / list
  // ----------------------------------------------------------------
  async search(dto: SearchArtistsDto) {
    const page  = dto.page  ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    let query = this.db('artist_profiles as ap')
      .join('users as u', 'u.id', 'ap.user_id')
      .where('u.status', 'active')
      .select(
        'ap.id',
        'ap.user_id',
        'ap.display_name',
        'ap.bio',
        'ap.location_city',
        'ap.location_country',
        'ap.base_price_usd',
        'ap.languages',
        'ap.social_links',
        'ap.is_verified',
        'ap.thumbnail_url',
        'ap.created_at',
      );

    // Filters
    if (dto.q) {
      query = query.whereRaw(
        `(ap.display_name ILIKE ? OR ap.bio ILIKE ?)`,
        [`%${dto.q}%`, `%${dto.q}%`],
      );
    }

    // Matches ANY artist who has at least one category in the requested list
    if (dto.categories?.length) {
      query = query.whereExists(
        this.db('artist_categories as ac')
          .join('categories as c', 'c.id', 'ac.category_id')
          .where('ac.artist_profile_id', this.db.ref('ap.id'))
          .whereIn('c.slug', dto.categories)
          .select(1),
      );
    }

    if (dto.country) {
      query = query.whereILike('ap.location_country', dto.country);
    }

    if (dto.city) {
      query = query.whereILike('ap.location_city', dto.city);
    }

    if (dto.minPrice !== undefined) {
      query = query.where('ap.base_price_usd', '>=', dto.minPrice);
    }

    if (dto.maxPrice !== undefined) {
      query = query.where('ap.base_price_usd', '<=', dto.maxPrice);
    }

    if (dto.verifiedOnly) {
      query = query.where('ap.is_verified', true);
    }

    // Availability — exclude artists with a block covering the requested date
    if (dto.availableOn) {
      query = query.whereNotExists(
        this.db('availability_blocks as ab')
          .where('ab.artist_id', this.db.ref('ap.user_id'))
          .where('ab.start_date', '<=', dto.availableOn)
          .where('ab.end_date',   '>=', dto.availableOn)
          .select(1),
      );
    }

    // Sorting
    switch (dto.sort) {
      case 'price_asc':  query = query.orderBy('ap.base_price_usd', 'asc');  break;
      case 'price_desc': query = query.orderBy('ap.base_price_usd', 'desc'); break;
      case 'newest':
      default:           query = query.orderBy('ap.created_at', 'desc');     break;
    }

    // Total count (same filters, no pagination)
    const countQuery = query.clone().clearSelect().clearOrder().count('ap.id as total').first();
    const [countRow, rows] = await Promise.all([
      countQuery,
      query.limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    // Attach each artist's categories in one follow-up query (avoids N+1)
    const artistIds = rows.map((r) => r.id);
    const categoryRows = artistIds.length
      ? await this.db('artist_categories as ac')
          .join('categories as c', 'c.id', 'ac.category_id')
          .whereIn('ac.artist_profile_id', artistIds)
          .select('ac.artist_profile_id', 'c.id', 'c.name', 'c.slug')
      : [];

    const categoriesByArtist = new Map<string, { id: string; name: string; slug: string }[]>();
    for (const cr of categoryRows) {
      const list = categoriesByArtist.get(cr.artist_profile_id) ?? [];
      list.push({ id: cr.id, name: cr.name, slug: cr.slug });
      categoriesByArtist.set(cr.artist_profile_id, list);
    }

    const data = rows.map((r) => ({
      ...r,
      categories: categoriesByArtist.get(r.id) ?? [],
    }));

    return {
      data,
      meta: {
        total:   Number(total),
        page,
        limit,
        pages:   Math.ceil(Number(total) / limit),
      },
    };
  }

  // ----------------------------------------------------------------
  // Get single artist profile (public)
  // ----------------------------------------------------------------
  async findOne(artistProfileId: string) {
    const profile = await this.db('artist_profiles as ap')
      .join('users as u', 'u.id', 'ap.user_id')
      .where('ap.id', artistProfileId)
      .where('u.status', 'active')
      .select(
        'ap.*',
        // Rating aggregates — populated by reviews.service.ts
        'ap.avg_rating',
        'ap.review_count',
      )
      .first();

    if (!profile) throw new NotFoundException('Artist not found.');

    // Attach categories
    const categories = await this.db('artist_categories as ac')
      .join('categories as c', 'c.id', 'ac.category_id')
      .where('ac.artist_profile_id', profile.id)
      .select('c.id', 'c.name', 'c.slug');

    // Attach media
    const media = await this.db('media')
      .where({ user_id: profile.user_id })
      .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'sort_order', order: 'asc' }])
      .select('id', 'media_type', 'cdn_url', 'duration_sec', 'is_primary', 'sort_order');

    // Attach upcoming availability blocks
    const availability = await this.db('availability_blocks')
      .where({ artist_id: profile.user_id })
      .where('end_date', '>=', this.db.raw('CURRENT_DATE'))
      .orderBy('start_date', 'asc')
      .select('id', 'start_date', 'end_date', 'note');

    // Completed bookings only — this replaced the star rating on the public
    // profile, so it has to mean "jobs actually played", not "enquiries
    // received". Accepted-but-not-yet-played and cancelled are excluded.
    const bookingsRow = await this.db('bookings')
      .where({ artist_id: profile.user_id, status: 'completed' })
      .count('id as count')
      .first();

    return {
      ...profile,
      categories,
      media,
      availability,
      bookings_count: aggregateValue(bookingsRow, 'count'),
    };
  }

  // ----------------------------------------------------------------
  // Get own profile (artist sees their own draft/pending state too)
  // ----------------------------------------------------------------
  async findMe(userId: string) {
    const profile = await this.db('artist_profiles as ap')
      .where('ap.user_id', userId)
      .select(
        'ap.*',
        'ap.avg_rating',
        'ap.review_count',
      )
      .first();

    if (!profile) throw new NotFoundException('Artist profile not found.');

    const categories = await this.db('artist_categories as ac')
      .join('categories as c', 'c.id', 'ac.category_id')
      .where('ac.artist_profile_id', profile.id)
      .select('c.id', 'c.name', 'c.slug');

    const media = await this.db('media')
      .where({ user_id: userId })
      .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'sort_order', order: 'asc' }])
      .select('id', 'media_type', 'cdn_url', 'file_size_bytes', 'duration_sec', 'is_primary', 'sort_order');

    return { ...profile, categories, media };
  }

  // ----------------------------------------------------------------
  // Update own profile
  // ----------------------------------------------------------------
  async updateMe(userId: string, dto: UpdateArtistProfileDto) {
    const profile = await this.db('artist_profiles').where({ user_id: userId }).first();
    if (!profile) throw new NotFoundException('Artist profile not found.');

    const patch: Record<string, any> = {};
    if (dto.displayName    !== undefined) patch.display_name     = dto.displayName;
    if (dto.bio            !== undefined) patch.bio              = dto.bio;
    if (dto.locationCity   !== undefined) patch.location_city    = dto.locationCity;
    if (dto.locationCountry !== undefined) patch.location_country = dto.locationCountry;
    if (dto.basePriceUsd   !== undefined) patch.base_price_usd   = dto.basePriceUsd;
    if (dto.languages      !== undefined) patch.languages        = JSON.stringify(dto.languages);
    if (dto.socialLinks    !== undefined) patch.social_links     = JSON.stringify(dto.socialLinks);

    // categoryIds is a full replace of the artist's category set (1–4 IDs)
    if (dto.categoryIds !== undefined) {
      const found = await this.db('categories').whereIn('id', dto.categoryIds).select('id');
      if (found.length !== dto.categoryIds.length) {
        throw new BadRequestException('One or more category IDs are invalid.');
      }

      await this.db.transaction(async (trx) => {
        if (Object.keys(patch).length > 0) {
          await trx('artist_profiles').where({ user_id: userId }).update(patch);
        }
        await trx('artist_categories').where({ artist_profile_id: profile.id }).del();
        await trx('artist_categories').insert(
          dto.categoryIds!.map((categoryId) => ({
            artist_profile_id: profile.id,
            category_id:       categoryId,
          })),
        );
      });

      return this.findMe(userId);
    }

    if (Object.keys(patch).length === 0) return this.findMe(userId);

    await this.db('artist_profiles').where({ user_id: userId }).update(patch);
    return this.findMe(userId);
  }

  // ----------------------------------------------------------------
  // List all categories, grouped — used by the search filter picker
  // and the artist onboarding category picker.
  // ----------------------------------------------------------------
  async getCategories() {
    const groups = await this.db('category_groups')
      .orderBy('sort_order', 'asc')
      .select('id', 'name', 'slug', 'icon', 'sort_order');

    const categories = await this.db('categories')
      .orderBy('sort_order', 'asc')
      .select('id', 'name', 'slug', 'group_id');

    return groups.map((g) => ({
      ...g,
      categories: categories.filter((c) => c.group_id === g.id),
    }));
  }

  // ----------------------------------------------------------------
  // "Who books you, by type" — this artist's bookings grouped by the
  // booking party's booker_type (Venue, Event Planner, …). Bookers who
  // haven't set a type yet are excluded. Ordered most-frequent first.
  // ----------------------------------------------------------------
  async getBookerTypeBreakdown(userId: string) {
    const rows = await this.db('bookings as b')
      .join('planner_profiles as pp', 'pp.user_id', 'b.planner_id')
      .where('b.artist_id', userId)
      .whereNotNull('pp.booker_type')
      .groupBy('pp.booker_type')
      .select('pp.booker_type as type')
      .count('b.id as count');

    const parsed = rows
      .map((r: { type: string; count: string | number }) => ({
        type: r.type,
        count: Number(r.count),
      }))
      .sort((a, b) => b.count - a.count);

    const total = parsed.reduce((sum, r) => sum + r.count, 0);

    return {
      total,
      breakdown: parsed.map((r) => ({
        ...r,
        pct: total ? Math.round((r.count / total) * 100) : 0,
      })),
    };
  }
}
