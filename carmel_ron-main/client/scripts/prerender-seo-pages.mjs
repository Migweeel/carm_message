import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDirectory = join(clientDirectory, 'dist')
const pages = JSON.parse(await readFile(join(clientDirectory, 'route-metadata.json'), 'utf8'))
const template = await readFile(join(distDirectory, 'index.html'), 'utf8')
const siteUrl = 'https://carmelsincommunion.org'
const socialImage = `${siteUrl}/assets/images/home-hero.jpg`

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function updateAttribute(tag, attribute, value) {
  const attributePattern = new RegExp(`\\b${attribute}="[^"]*"`, 'i')
  if (!attributePattern.test(tag)) {
    throw new Error(`Expected ${attribute} attribute in metadata tag: ${tag}`)
  }
  return tag.replace(attributePattern, `${attribute}="${escapeHtml(value)}"`)
}

function updateMeta(html, selector, value) {
  const selectorAttribute = selector.type === 'name' ? 'name' : 'property'
  const selectorValue = selector.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tagPattern = new RegExp(`<meta\\b(?=[^>]*\\b${selectorAttribute}="${selectorValue}")[^>]*>`, 'i')
  const tag = html.match(tagPattern)?.[0]
  if (!tag) {
    throw new Error(`Missing metadata tag: ${selectorAttribute}="${selector.value}"`)
  }
  return html.replace(tagPattern, updateAttribute(tag, 'content', value))
}

for (const [route, metadata] of Object.entries(pages)) {
  const canonicalUrl = `${siteUrl}${route === '/' ? '/' : route}`
  let html = template.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(metadata.title)}</title>`)
  html = html.replace(/<link\b(?=[^>]*\brel="canonical")[^>]*>/i, (tag) => updateAttribute(tag, 'href', canonicalUrl))
  html = updateMeta(html, { type: 'name', value: 'description' }, metadata.description)
  html = updateMeta(html, { type: 'property', value: 'og:title' }, metadata.title)
  html = updateMeta(html, { type: 'property', value: 'og:description' }, metadata.description)
  html = updateMeta(html, { type: 'property', value: 'og:url' }, canonicalUrl)
  html = updateMeta(html, { type: 'property', value: 'og:image' }, socialImage)
  html = updateMeta(html, { type: 'name', value: 'twitter:title' }, metadata.title)
  html = updateMeta(html, { type: 'name', value: 'twitter:description' }, metadata.description)
  html = updateMeta(html, { type: 'name', value: 'twitter:image' }, socialImage)

  const outputDirectory = route === '/' ? distDirectory : join(distDirectory, ...route.slice(1).split('/'))
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'index.html'), html)
}
