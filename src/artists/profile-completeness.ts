/**
 * The media an artist profile needs before it is worth showing to a booker.
 *
 * Artists only. Bookers are exempt entirely — most are venues or companies
 * with nothing to photograph, and requiring so much as a logo would cost
 * signups on the side of the marketplace that pays.
 */
export const REQUIRED_PROFILE_PICTURES = 1;
export const REQUIRED_GALLERY_IMAGES = 2;

export interface MediaItemLike {
  media_type: string;
  is_primary: boolean;
}

export interface ProfileCompleteness {
  meetsMediaMinimum: boolean;
  profilePictures: number;
  galleryImages: number;
  requiredProfilePictures: number;
  requiredGalleryImages: number;
  /** Human-readable, ready to show in a form. Empty when nothing is missing. */
  missing: string[];
}

/**
 * Reports what a profile is still missing.
 *
 * Reports rather than blocks, deliberately. An artist has to be able to
 * save a half-finished profile — they cannot upload photos to a profile
 * that refuses to exist — so this drives what the form asks for rather
 * than rejecting the write.
 *
 * The hard "this profile may go live" gate is a separate question, tied to
 * ID and selfie verification, and belongs with that work: applying it today
 * would hide five of the seven seeded artists from search.
 *
 * Videos deliberately do not count toward the gallery minimum. The
 * requirement exists so a search result has something to show, and a video
 * thumbnail is not guaranteed.
 */
export function computeProfileCompleteness(
  media: MediaItemLike[],
): ProfileCompleteness {
  const photos = media.filter((m) => m.media_type === 'photo');
  const profilePictures = photos.filter((m) => m.is_primary).length;
  const galleryImages = photos.filter((m) => !m.is_primary).length;

  const missing: string[] = [];
  if (profilePictures < REQUIRED_PROFILE_PICTURES) {
    missing.push('A profile picture');
  }
  if (galleryImages < REQUIRED_GALLERY_IMAGES) {
    const short = REQUIRED_GALLERY_IMAGES - galleryImages;
    missing.push(
      `${short} more gallery image${short === 1 ? '' : 's'}`,
    );
  }

  return {
    meetsMediaMinimum: missing.length === 0,
    profilePictures,
    galleryImages,
    requiredProfilePictures: REQUIRED_PROFILE_PICTURES,
    requiredGalleryImages: REQUIRED_GALLERY_IMAGES,
    missing,
  };
}
