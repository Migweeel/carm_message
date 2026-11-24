import { forwardRef, useCallback, useState, type ImgHTMLAttributes } from 'react'
import './image-loading.css'

const transparentImagePixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const loadedImageSources = new Set<string>()
const failedImageSources = new Set<string>()

type ImageWithLoaderProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string
  pending?: boolean
}

const ImageWithLoader = forwardRef<HTMLImageElement, ImageWithLoaderProps>(function ImageWithLoader(
  { src, pending = false, className = '', loading = 'lazy', decoding = 'async', fetchPriority = 'auto', onLoad, onError, ...props },
  ref,
) {
  const source = pending || !src?.trim() ? undefined : src
  const [, setVersion] = useState(0)

  const isAlreadyLoaded = Boolean(source && loadedImageSources.has(source))
  const isAlreadyFailed = Boolean(source && failedImageSources.has(source))
  const isLoading = (pending && !isAlreadyLoaded) || Boolean(source && !isAlreadyLoaded && !isAlreadyFailed)
  const state = isLoading ? 'loading' : source ? isAlreadyFailed ? 'error' : 'loaded' : 'empty'

  const setCombinedRef = useCallback((node: HTMLImageElement | null) => {
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
    if (node && source && !loadedImageSources.has(source) && node.complete && node.naturalWidth > 0) {
      loadedImageSources.add(source)
      failedImageSources.delete(source)
      setVersion((v) => v + 1)
    }
  }, [ref, source])

  return <img
    {...props}
    ref={setCombinedRef}
    className={`site-image-loading${className ? ` ${className}` : ''}`}
    loading={loading}
    decoding={decoding}
    fetchPriority={fetchPriority}
    data-image-state={state}
    aria-busy={isLoading || undefined}
    src={source && isAlreadyFailed ? transparentImagePixel : source}
    onLoad={(event) => {
      if (source && !loadedImageSources.has(source)) {
        loadedImageSources.add(source)
        failedImageSources.delete(source)
        setVersion((v) => v + 1)
      }
      onLoad?.(event)
    }}
    onError={(event) => {
      if (source && !failedImageSources.has(source)) {
        failedImageSources.add(source)
        setVersion((v) => v + 1)
      }
      onError?.(event)
    }}
  />
})

export default ImageWithLoader
