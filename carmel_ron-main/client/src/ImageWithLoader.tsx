import { forwardRef, useState, type ImgHTMLAttributes } from 'react'
import './image-loading.css'

const transparentImagePixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

type ImageWithLoaderProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string
  pending?: boolean
}

const ImageWithLoader = forwardRef<HTMLImageElement, ImageWithLoaderProps>(function ImageWithLoader(
  { src, pending = false, className = '', onLoad, onError, ...props },
  ref,
) {
  const source = pending || !src?.trim() ? undefined : src
  const [loadedSource, setLoadedSource] = useState('')
  const [failedSource, setFailedSource] = useState('')
  const loading = pending || Boolean(source && source !== loadedSource && source !== failedSource)
  const state = loading ? 'loading' : source ? failedSource === source ? 'error' : 'loaded' : 'empty'

  return <img
    {...props}
    key={source || 'empty'}
    ref={ref}
    className={`site-image-loading${className ? ` ${className}` : ''}`}
    data-image-state={state}
    aria-busy={loading || undefined}
    src={source && failedSource === source ? transparentImagePixel : source}
    onLoad={(event) => {
      if (source) setLoadedSource(source)
      onLoad?.(event)
    }}
    onError={(event) => {
      if (source) setFailedSource(source)
      onError?.(event)
    }}
  />
})

export default ImageWithLoader
