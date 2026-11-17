import { Helmet } from 'react-helmet-async'
import { useLocation } from 'react-router-dom'

const siteUrl = 'https://carmelsincommunion.org'
const socialImage = `${siteUrl}/assets/images/home-hero.jpg`
const defaultDescription = 'Official website of the Philippine Federation of Discalced Carmelite Nuns. Explore our monasteries, Carmelite life, vocation discernment, teachings, news, and ways to support the Federation.'

const pages: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Carmels in Communion | Philippine Federation of Discalced Carmelite Nuns',
    description: defaultDescription,
  },
  '/about': {
    title: 'About the Federation | Carmels in Communion',
    description: 'Learn about the Philippine Federation of Discalced Carmelite Nuns, its 23 monastery members, Teresian charism, and shared mission.',
  },
  '/spirituality': {
    title: 'Carmelite Spirituality | Carmels in Communion',
    description: 'Explore the Christ-centered, Marian, and biblical traditions that shape the contemplative life of the Discalced Carmelite Nuns.',
  },
  '/monasteries': {
    title: 'Carmelite Monasteries | Carmels in Communion',
    description: 'Find the Carmelite communities of the Philippine Federation and learn about the monasteries that share one contemplative life.',
  },
  '/carmelife': {
    title: 'Vocation to Carmel | Carmels in Communion',
    description: 'Discover the Carmelite vocation, Teresian charism, and contemplative way of life.',
  },
  '/carmelife/stories': {
    title: 'Stories of Carmelite Life | Carmels in Communion',
    description: 'Read stories about the prayer, community, and vocation of the Discalced Carmelite Nuns.',
  },
  '/discernment': {
    title: 'Vocation Discernment | Carmels in Communion',
    description: 'Explore guidance and resources for discerning a vocation to the contemplative life of the Discalced Carmelite Nuns.',
  },
  '/carmelights': {
    title: 'Carmelights | Carmels in Communion',
    description: 'Read Carmelite teachings, reflections, and stories from the spiritual tradition of Carmel.',
  },
  '/updates': {
    title: 'News and Updates | Carmels in Communion',
    description: 'Read news, gatherings, and updates from the Philippine Federation of Discalced Carmelite Nuns.',
  },
  '/contact': {
    title: 'Contact the Federation | Carmels in Communion',
    description: 'Contact the Philippine Federation of Discalced Carmelite Nuns with questions about the communities or vocation discernment.',
  },
  '/donations': {
    title: 'Support the Federation | Carmels in Communion',
    description: 'Support the work and communities of the Philippine Federation of Discalced Carmelite Nuns.',
  },
  '/account/login': {
    title: 'Member Sign In | Carmels in Communion',
    description: 'Sign in to your Carmels in Communion member account.',
  },
}

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
