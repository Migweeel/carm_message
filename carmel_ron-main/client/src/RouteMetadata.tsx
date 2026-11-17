import { Helmet } from 'react-helmet-async'
import { useLocation } from 'react-router-dom'
import pageMetadata from '../route-metadata.json'

const siteUrl = 'https://carmelsincommunion.org'
const socialImage = `${siteUrl}/assets/images/home-hero.jpg`
const defaultDescription = 'Official website of the Philippine Federation of Discalced Carmelite Nuns. Explore our monasteries, Carmelite life, vocation discernment, teachings, news, and ways to support the Federation.'

const pages: Record<string, { title: string; description: string }> = pageMetadata

export default function RouteMetadata() {
  const { pathname } = useLocation()
  const path = pathname === '/' ? '/' : pathname.replace(/\/+$/, '')
  const page = pages[path]
  const protectedPath = /^\/(account|admin|staff)(\/|$)/.test(path)
  const indexable = Boolean(page) && path !== '/search' && (!protectedPath || path === '/account/login')
  const title = page?.title ?? 'Page not found | Carmels in Communion'
  const description = page?.description ?? defaultDescription
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
    <meta property="og:image" content={socialImage} />
    <meta property="og:image:alt" content="Hands holding a candle in prayer" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <meta name="twitter:image" content={socialImage} />
    {!indexable && <meta name="robots" content="noindex,nofollow" />}
  </Helmet>
}
