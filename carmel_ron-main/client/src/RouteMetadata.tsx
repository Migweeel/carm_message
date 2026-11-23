import { Helmet } from 'react-helmet-async'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import pageMetadata from '../route-metadata.json'

const siteUrl = 'https://carmelsincommunion.org'
const socialImage = `${siteUrl}/assets/images/home-hero.jpg`
const defaultDescription = 'Official website of the Philippine Federation of Discalced Carmelite Nuns. Explore our monasteries, Carmelite life, vocation discernment, teachings, news, and ways to support the Federation.'

const pages: Record<string, { title: string; description: string }> = pageMetadata
const accountPageTitles: Record<string, string> = {
  '/account': 'Profile details',
  '/account/donations': 'Donation history',
  '/account/discernment': 'Discernment',
  '/account/security': 'Security & privacy',
  '/account/messages': 'Messages',
  '/account/favorites': 'Favorite teachings',
  '/account/recommendations': 'Recommended for You',
}
function socialImageForUpdate(image?: string) {
  if (!image || image.startsWith('data:')) return socialImage
  try {
    const url = new URL(image, siteUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : socialImage
  } catch {
    return socialImage
  }
}

export default function RouteMetadata() {
  const { pathname } = useLocation()
  const path = pathname === '/' ? '/' : pathname.replace(/\/+$/, '')
  const [loadedUpdateMetadata, setLoadedUpdateMetadata] = useState<{ id: string; title: string; description: string; image: string } | null>(null)
  const updateId = path.startsWith('/updates/') ? path.slice('/updates/'.length) : ''
  useEffect(() => {
    if (!updateId) return
    let active = true
    fetch('/api/content/SITE_UPDATES').then(async (response) => {
      if (!response.ok) throw new Error('Update details could not be loaded.')
      const result: { content?: { blocks?: unknown } } = await response.json()
      const updates = result.content?.blocks
      if (!Array.isArray(updates)) throw new Error('Saved updates have an invalid format.')
      const update = updates.find((entry: unknown): entry is { id: string; title: string; body: string; image?: string } =>
        Boolean(entry && typeof entry === 'object' && 'id' in entry && 'title' in entry && 'body' in entry &&
          entry.id === updateId && typeof entry.title === 'string' && typeof entry.body === 'string'
          && (!('image' in entry) || typeof entry.image === 'string')))
      if (active) setLoadedUpdateMetadata(update ? {
        id: updateId,
        title: `${update.title} | Carmels in Communion`,
        description: update.body.replace(/\s+/g, ' ').trim().slice(0, 300),
        image: socialImageForUpdate(update.image),
      } : null)
    }).catch((error: unknown) => console.error('Unable to load update metadata.', error))
    return () => { active = false }
  }, [updateId])
  const updateMetadata = loadedUpdateMetadata?.id === updateId ? loadedUpdateMetadata : null
  const page = pages[path]
  const accountPageTitle = accountPageTitles[path]
  const protectedPath = /^\/(account|admin|staff)(\/|$)/.test(path)
  const indexable = Boolean(page || updateMetadata) && path !== '/search' && (!protectedPath || path === '/account/login')
  const adminPage = path === '/admin' || path.startsWith('/admin/')
  const title = updateMetadata?.title ?? page?.title ?? (accountPageTitle ? `${accountPageTitle} | Carmels in Communion` : adminPage ? 'Federation administration | Carmels in Communion' : 'Page not found | Carmels in Communion')
  const description = updateMetadata?.description ?? page?.description ?? (accountPageTitle ? 'Manage your profile and account details.' : defaultDescription)
  const metadataImage = updateMetadata?.image ?? socialImage
  const canonicalUrl = `${siteUrl}${path === '/' ? '/' : path}`

  return <Helmet>
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonicalUrl} />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Carmels in Communion" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonicalUrl} />
    <meta property="og:image" content={metadataImage} />
    <meta property="og:image:alt" content="Hands holding a candle in prayer" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <meta name="twitter:image" content={metadataImage} />
    {!indexable && <meta name="robots" content="noindex,nofollow" />}
  </Helmet>
}
