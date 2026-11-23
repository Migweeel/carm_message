import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import ImageWithLoader from './ImageWithLoader'
import { homeSectionCards, type HomeSectionKey } from './home-section-cards'
import { cacheHomepageHeroImages, getHomepageHeroImages, homepageHeroImageFallback } from './homepage-hero-images'
import './homepage-reference.css'

const cities = ['Angeles', 'Bacolod', 'Baguio', 'Cagayan de Oro', 'Castillejos', 'Cebu', 'Davao', 'Gumaca', 'Infanta']
const maxInlineHeroImageLength = 350_000

export default function HomepageReference() {
  const cards = useRef<HTMLDivElement>(null)
  const cardDrag = useRef<{ pointerId: number; startX: number; startScrollLeft: number; moved: boolean } | null>(null)
  const suppressCardClick = useRef(false)
  const [heroImages, setHeroImages] = useState<string[]>([])
  const [heroImageLoading, setHeroImageLoading] = useState(true)
  const [activeHeroIndex, setActiveHeroIndex] = useState(0)
  const [activeCardIndex, setActiveCardIndex] = useState(0)
  const [sectionImages, setSectionImages] = useState<Partial<Record<HomeSectionKey, string>>>({})
  const [sectionImagesReady, setSectionImagesReady] = useState(false)
  const [sectionImagesLoading, setSectionImagesLoading] = useState(true)

  function scrollCards(direction: number) {
    cards.current?.scrollBy({ left: direction * 280, behavior: 'smooth' })
  }

  function changeHeroImage(direction: -1 | 1) {
    if (heroImages.length < 2) return
    setActiveHeroIndex((current) => (current + direction + heroImages.length) % heroImages.length)
  }

  function scrollToCard(index: number) {
    const container = cards.current
    const card = container?.children.item(index)
    if (!container || !(card instanceof HTMLElement)) return

    const containerLeft = container.getBoundingClientRect().left + container.clientLeft
    const targetLeft = container.scrollLeft + card.getBoundingClientRect().left - containerLeft
    container.scrollTo({ left: targetLeft, behavior: 'smooth' })
  }

  function updateActiveCard() {
    const container = cards.current
    if (!container) return

    const containerLeft = container.getBoundingClientRect().left + container.clientLeft
    let closestIndex = 0
    let closestDistance = Number.POSITIVE_INFINITY
    Array.from(container.children).forEach((card, index) => {
      if (!(card instanceof HTMLElement)) return
      const distance = Math.abs(card.getBoundingClientRect().left - containerLeft)
      if (distance < closestDistance) {
        closestIndex = index
        closestDistance = distance
      }
    })
    setActiveCardIndex((current) => current === closestIndex ? current : closestIndex)
  }

  function startCardDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    cardDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: event.currentTarget.scrollLeft,
      moved: false,
    }
  }

  function moveCardDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = cardDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const distance = event.clientX - drag.startX
    if (!drag.moved && Math.abs(distance) < 5) return
    if (!drag.moved) {
      drag.moved = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.classList.add('is-dragging')
    }

    event.preventDefault()
    event.currentTarget.scrollLeft = drag.startScrollLeft - distance
  }

  function endCardDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = cardDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return

    cardDrag.current = null
    event.currentTarget.classList.remove('is-dragging')
    if (!drag.moved) return

    suppressCardClick.current = true
    window.setTimeout(() => {
      suppressCardClick.current = false
    }, 0)
  }

  function handleCardClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!suppressCardClick.current) return
    event.preventDefault()
    event.stopPropagation()
    suppressCardClick.current = false
  }

  function preventCardDrag(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
  }

  const activeHeroImage = heroImages[activeHeroIndex]

  useEffect(() => {
    let active = true
    let requestGeneration = 0
    async function loadHeroImage() {
      const currentRequest = ++requestGeneration
      setHeroImages([])
      setHeroImageLoading(true)
      setActiveHeroIndex(0)
      try {
        const response = await fetch('/api/content/HOME_HERO_IMAGE', { cache: 'no-store' })
        if (response.status === 404) {
          if (active && currentRequest === requestGeneration) setHeroImages([homepageHeroImageFallback])
          return
        }
        if (!response.ok) throw new Error('The saved homepage image could not be loaded.')
        const result: { content?: { blocks?: unknown } } = await response.json()
        const savedImages = getHomepageHeroImages(result.content?.blocks)
        const displayImages = savedImages.filter((image) => !image.startsWith('data:image/') || image.length <= maxInlineHeroImageLength)
        if (active && currentRequest === requestGeneration) {
          setHeroImages(displayImages.length ? displayImages : [homepageHeroImageFallback])
          setActiveHeroIndex(0)
          cacheHomepageHeroImages(displayImages.length ? displayImages : [homepageHeroImageFallback])
        }
      } catch (error) {
        if (active && currentRequest === requestGeneration) console.error('Unable to load the saved homepage image.', error)
      } finally {
        if (active && currentRequest === requestGeneration) setHeroImageLoading(false)
      }
    }
    void loadHeroImage()
    window.addEventListener('carmel-home-hero-updated', loadHeroImage)
    window.addEventListener('focus', loadHeroImage)
    return () => {
      active = false
      window.removeEventListener('carmel-home-hero-updated', loadHeroImage)
      window.removeEventListener('focus', loadHeroImage)
    }
  }, [])

  useEffect(() => {
    if (heroImages.length < 2) return
    const previousImage = new window.Image()
    const nextImage = new window.Image()
    previousImage.src = heroImages[(activeHeroIndex - 1 + heroImages.length) % heroImages.length]
    nextImage.src = heroImages[(activeHeroIndex + 1) % heroImages.length]
  }, [activeHeroIndex, heroImages])

  useEffect(() => {
    let active = true
    let requestGeneration = 0
    async function loadSectionImages() {
      const currentRequest = ++requestGeneration
      setSectionImages({})
      setSectionImagesReady(false)
      setSectionImagesLoading(true)
      try {
        const response = await fetch('/api/content/HOME_SECTION_IMAGES', { cache: 'no-store' })
        if (response.status === 404) {
          if (active && currentRequest === requestGeneration) setSectionImagesReady(true)
          return
        }
        if (!response.ok) throw new Error('The saved homepage thumbnails could not be loaded.')
        const result: { content?: { blocks?: unknown } } = await response.json()
        const blocks = result.content?.blocks
        if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) throw new Error('Saved homepage thumbnails have an invalid format.')
        const blockValues = blocks as Record<string, unknown>
        const images = homeSectionCards.reduce<Partial<Record<HomeSectionKey, string>>>((saved, card) => {
          const savedImage = blockValues[card.key]
          if (typeof savedImage === 'string' && savedImage.trim()) saved[card.key] = savedImage
          return saved
        }, {})
        if (active && currentRequest === requestGeneration) {
          setSectionImages(images)
          setSectionImagesReady(true)
        }
      } catch (error) {
        if (active && currentRequest === requestGeneration) console.error('Unable to load saved homepage thumbnails.', error)
      } finally {
        if (active && currentRequest === requestGeneration) setSectionImagesLoading(false)
      }
    }
    void loadSectionImages()
    window.addEventListener('carmel-home-section-images-updated', loadSectionImages)
    window.addEventListener('focus', loadSectionImages)
    return () => {
      active = false
      window.removeEventListener('carmel-home-section-images-updated', loadSectionImages)
      window.removeEventListener('focus', loadSectionImages)
    }
  }, [])

  return <div className="reference-home">
    <section className="reference-hero" id="home">
      <ImageWithLoader key={activeHeroImage || 'hero-pending'} className="reference-hero-image" src={activeHeroImage} pending={heroImageLoading} alt="" aria-hidden="true" loading={activeHeroIndex === 0 ? 'eager' : 'lazy'} fetchPriority={activeHeroIndex === 0 ? 'high' : 'auto'} decoding="async" />
      <div className="reference-hero-overlay" />
      {heroImages.length > 1 && <div className="reference-hero-controls" role="group" aria-label="Featured images">
        <button type="button" onClick={() => changeHeroImage(-1)} aria-label="Previous featured image"><ChevronLeft size={18} /></button>
        <span aria-live="polite" aria-atomic="true">{activeHeroIndex + 1} / {heroImages.length}</span>
        <button type="button" onClick={() => changeHeroImage(1)} aria-label="Next featured image"><ChevronRight size={18} /></button>
      </div>}
      <div className="reference-hero-content">
        <p className="reference-kicker">A HOME FOR THE SEEKING HEART</p>
        <h1>Carmels in<br /><em>Communion</em></h1>
        <p>Welcome! You have arrived at the official website of the Philippine Federation of Discalced Carmelite Nuns for vocation promotion.</p>
        <div className="reference-actions"><a className="reference-primary" href="#home-explore">Explore</a><Link className="reference-secondary" to="/monasteries">Meet our Monasteries</Link></div>
      </div>
    </section>
    <section className="reference-ticker"><strong>Philippine Federation of Discalced Carmelite Nuns</strong><div className="reference-ticker-window"><div className="reference-ticker-track">{cities.map((city) => <Link key={city} to={`/monasteries#monastery-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{city}<i>·</i></Link>)}{cities.map((city) => <Link key={`duplicate-${city}`} to={`/monasteries#monastery-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} aria-hidden="true" tabIndex={-1}>{city}<i>·</i></Link>)}</div></div></section>
    <section className="reference-discernment"><ImageWithLoader src="/assets/images/whiteflowers.webp" alt="White flowers in a garden" /><div><h2>Is <b>GOD</b> calling you to be a<br /> Discalced Carmelite Nun?</h2><p>Are you discerning if God is calling you to Carmel? Let us assist you in your discernment as you explore the pages of this site.</p><Link className="reference-primary" to="/monasteries">Meet Our Monasteries</Link></div></section>
    <section className="reference-explore" id="home-explore"><div className="reference-explore-heading"><div><p className="reference-kicker">FIND YOUR WAY IN</p><h2>Explore</h2></div><p>Learn about our charism, communities, and the women who have found a home in Carmel.</p></div><div className="reference-carousel"><button type="button" onClick={() => scrollCards(-1)} aria-label="Scroll left"><ArrowLeft size={18} /></button><div className="reference-cards" ref={cards} onDragStart={preventCardDrag} onScroll={updateActiveCard} onPointerDown={startCardDrag} onPointerMove={moveCardDrag} onPointerUp={endCardDrag} onPointerCancel={endCardDrag} onClickCapture={handleCardClick}>{homeSectionCards.map(({ key, label, title, to, image }) => <Link className="reference-card" key={key} to={to}><ImageWithLoader src={sectionImagesReady ? sectionImages[key] || image : undefined} pending={sectionImagesLoading} alt="" loading="lazy" decoding="async" draggable={false} /><span>{label}</span><div><h3>{title}</h3><b>Learn More <ArrowRight size={14} /></b></div></Link>)}</div><button type="button" onClick={() => scrollCards(1)} aria-label="Scroll right"><ArrowRight size={18} /></button></div><div className="reference-carousel-dots" role="group" aria-label="Explore categories">{homeSectionCards.map(({ key, label }, index) => <button key={key} type="button" className={index === activeCardIndex ? 'reference-carousel-dot is-active' : 'reference-carousel-dot'} aria-label={`Go to ${label.toLowerCase()} slide`} aria-current={index === activeCardIndex ? 'true' : undefined} onClick={() => scrollToCard(index)} />)}</div></section>
    <section className="reference-quote"><ImageWithLoader src="/assets/images/pinkflower.webp" alt="Pink flower" /><div><span className="reference-quote-mark" aria-hidden="true">"</span><p>Carmel is not merely a geographical place, but a sacred space in the cloister of the heart where the Carmelite nun encounters God.</p><Link className="reference-secondary" to="/contact">We'd love to hear from you <ArrowRight size={15} /></Link></div></section>
  </div>
}
