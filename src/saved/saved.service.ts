import { Injectable } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';

@Injectable()
export class SavedService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // Idempotent — saving an already-saved artist just no-ops rather than
  // erroring, so the frontend can always call this without checking first.
  async save(plannerId: string, artistProfileId: string): Promise<{ message: string }> {
    await this.db('saved_artists')
      .insert({ planner_id: plannerId, artist_profile_id: artistProfileId })
      .onConflict(['planner_id', 'artist_profile_id'])
      .ignore();
    return { message: 'Saved.' };
  }

  async unsave(plannerId: string, artistProfileId: string): Promise<{ message: string }> {
    await this.db('saved_artists')
      .where({ planner_id: plannerId, artist_profile_id: artistProfileId })
      .delete();
    return { message: 'Removed.' };
  }

  // Returns the same card shape ArtistsService.search() returns, so the
  // frontend can reuse its existing ArtistCard component unmodified.
  async listMine(plannerId: string) {
    const rows = await this.db('saved_artists as sa')
      .join('artist_profiles as ap', 'ap.id', 'sa.artist_profile_id')
      .where('sa.planner_id', plannerId)
      .orderBy('sa.created_at', 'desc')
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
        'sa.created_at as saved_at',
      );

    if (rows.length === 0) return [];

    const artistProfileIds = rows.map((r) => r.id);
    const categoryRows = await this.db('artist_categories as ac')
      .join('categories as c', 'c.id', 'ac.category_id')
      .whereIn('ac.artist_profile_id', artistProfileIds)
      .select('ac.artist_profile_id', 'c.id', 'c.name', 'c.slug');

    const categoriesByArtist = new Map<string, { id: string; name: string; slug: string }[]>();
    for (const cr of categoryRows) {
      const list = categoriesByArtist.get(cr.artist_profile_id) ?? [];
      list.push({ id: cr.id, name: cr.name, slug: cr.slug });
      categoriesByArtist.set(cr.artist_profile_id, list);
    }

    return rows.map((r) => ({ ...r, categories: categoriesByArtist.get(r.id) ?? [] }));
  }

  // Used by the frontend to show a filled/outline heart per artist card
  // without an extra round trip per card.
  async listMySavedIds(plannerId: string): Promise<string[]> {
    const rows = await this.db('saved_artists')
      .where({ planner_id: plannerId })
      .select('artist_profile_id');
    return rows.map((r) => r.artist_profile_id);
  }
}
