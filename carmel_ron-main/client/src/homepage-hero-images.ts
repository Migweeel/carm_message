export const homepageHeroImagesCacheKey = 'carmel-home-hero-images-v3'
export const legacyHomepageHeroImageCacheKey = 'carmel-home-hero-image-v2'
export const homepageHeroImageFallback = '/assets/images/home-hero.jpg'
const maxHomepageHeroImagesCacheLength = 2_000_000

export function getHomepageHeroImages(blocks: unknown): string[] {
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) return []
  const values = blocks as Record<string, unknown>
  if (Array.isArray(values.images)) {
    return values.images.filter((image): image is string => typeof image === 'string' && Boolean(image.trim()))
  }
  return typeof values.image === 'string' && values.image.trim() ? [values.image] : []
}

export function readCachedHomepageHeroImages(fallbackImage = homepageHeroImageFallback): string[] {
  try {
    const cached = localStorage.getItem(homepageHeroImagesCacheKey)
    if (cached) {
      const images: unknown = JSON.parse(cached)
      if (Array.isArray(images) && images.every((image) => typeof image === 'string')) return images
      throw new Error('The cached homepage slideshow has an invalid format.')
    }
    const legacyImage = localStorage.getItem(legacyHomepageHeroImageCacheKey)
    return legacyImage ? [legacyImage] : [fallbackImage]
  } catch (error) {
    console.error('Unable to read the cached homepage images.', error)
    return [fallbackImage]
  }
}

export function cacheHomepageHeroImages(images: string[]) {
  try {
    const serialized = JSON.stringify(images)
    if (images.length && serialized.length <= maxHomepageHeroImagesCacheLength) {
      localStorage.setItem(homepageHeroImagesCacheKey, serialized)
    } else {
      localStorage.removeItem(homepageHeroImagesCacheKey)
    }
    localStorage.removeItem(legacyHomepageHeroImageCacheKey)
  } catch (error) {
    console.error('Unable to cache the homepage images.', error)
  }
}
