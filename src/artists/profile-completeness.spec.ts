import { computeProfileCompleteness } from './profile-completeness';

const photo = (isPrimary = false) => ({ media_type: 'photo', is_primary: isPrimary });
const video = () => ({ media_type: 'video', is_primary: false });

describe('computeProfileCompleteness()', () => {
  it('is satisfied by a profile picture plus two gallery images', () => {
    const result = computeProfileCompleteness([photo(true), photo(), photo()]);

    expect(result.meetsMediaMinimum).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('names what is missing on an empty profile', () => {
    const result = computeProfileCompleteness([]);

    expect(result.meetsMediaMinimum).toBe(false);
    expect(result.missing).toEqual(['A profile picture', '2 more gallery images']);
  });

  it('counts down the shortfall rather than repeating the total', () => {
    // "1 more gallery image" is actionable; "2 gallery images required" when
    // you already have one is not.
    const result = computeProfileCompleteness([photo(true), photo()]);

    expect(result.missing).toEqual(['1 more gallery image']);
  });

  it('does not count the profile picture toward the gallery', () => {
    // Otherwise a single upload satisfies two separate requirements.
    const result = computeProfileCompleteness([photo(true)]);

    expect(result.galleryImages).toBe(0);
    expect(result.missing).toEqual(['2 more gallery images']);
  });

  it('does not let videos stand in for gallery images', () => {
    // The requirement exists so a search result has something to show, and
    // a video thumbnail is not guaranteed.
    const result = computeProfileCompleteness([photo(true), video(), video()]);

    expect(result.meetsMediaMinimum).toBe(false);
    expect(result.galleryImages).toBe(0);
  });

  it('reports a gallery with no profile picture as incomplete', () => {
    const result = computeProfileCompleteness([photo(), photo(), photo()]);

    expect(result.meetsMediaMinimum).toBe(false);
    expect(result.missing).toEqual(['A profile picture']);
  });

  it('returns the thresholds so the client does not hardcode them', () => {
    const result = computeProfileCompleteness([]);

    expect(result.requiredProfilePictures).toBe(1);
    expect(result.requiredGalleryImages).toBe(2);
  });
});
