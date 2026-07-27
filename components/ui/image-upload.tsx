'use client'

import { upload } from '@vercel/blob/client'
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { Button } from '@/components/ui/button'
import Image from 'next/image'
import { ImagePlus, Trash, GripVertical } from 'lucide-react'
import { Input } from './input'
import { isPublicDemoModeEnabled } from '@/lib/demo-mode'

interface ImageUploadProps {
  disabled?: boolean
  onChange: (
    value: { id?: string; url: string; credit: string; ordering: number }[]
  ) => void
  onRemove: (value: string) => void
  value: {
    url: string
    credit: string
    ordering: number
  }[]
}

const ImageUpload: React.FC<ImageUploadProps> = ({
  disabled,
  onChange,
  onRemove,
  value
}) => {
  const [isMounted, setIsMounted] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // Sort images by ordering and then by URL to ensure consistent ordering
  const sortedImages = [...value].sort((a, b) => {
    if (a.ordering !== b.ordering) {
      return a.ordering - b.ordering
    }
    return a.url.localeCompare(b.url)
  })

  const handleBlobFilesSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files
    e.target.value = ''
    if (!files || files.length === 0) return

    setIsUploading(true)
    try {
      let maxOrdering =
        value.length > 0 ? Math.max(...value.map((img) => img.ordering)) : -1
      const uploaded: typeof value = []

      for (const file of Array.from(files)) {
        const blob = await upload(file.name, file, {
          access: 'public',
          handleUploadUrl: '/api/upload'
        })
        maxOrdering += 1
        uploaded.push({ url: blob.url, credit: '', ordering: maxOrdering })
      }

      onChange([...value, ...uploaded])
    } catch (error) {
      toast.error('Failed to upload image')
    } finally {
      setIsUploading(false)
    }
  }

  const handleCreditChange = (url: string, credit: string) => {
    const updatedValue = value.map((item) =>
      item.url === url ? { ...item, credit } : item
    )
    onChange(updatedValue)
  }

  const reorderImages = (fromIndex: number, toIndex: number) => {
    const newImages = [...sortedImages]
    const [movedImage] = newImages.splice(fromIndex, 1)
    newImages.splice(toIndex, 0, movedImage)

    // Update ordering based on new positions
    const updatedImages = newImages.map((image, index) => ({
      ...image,
      ordering: index
    }))

    onChange(updatedImages)
  }

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOverIndex(null)
  }

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== dropIndex) {
      reorderImages(draggedIndex, dropIndex)
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const handleDragEnd = () => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  if (!isMounted) {
    return null
  }

  // Vercel Blob is the storage backend when its token is provisioned (e.g. via
  // the "Deploy to Vercel" button's bundled Blob store) — see
  // NEXT_PUBLIC_BLOB_ENABLED in next.config.js, which mirrors the server-only
  // BLOB_READ_WRITE_TOKEN at build time so the client can branch on it.
  const blobConfigured = process.env.NEXT_PUBLIC_BLOB_ENABLED === 'true'

  return (
    <div className="space-y-4">
      {sortedImages.length > 0 && (
        <div className="space-y-2">
          {/* First image indicator */}
          <div className="text-sm text-muted-foreground">
            The first image will be used as the product's thumbnail
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {sortedImages.map((image, index) => {
              const { url, credit } = image
              const isDragging = draggedIndex === index
              const isDropTarget = dragOverIndex === index

              return (
                <div
                  key={url}
                  draggable={!disabled}
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  className={`
                    relative group bg-muted rounded-lg p-2 border transition-all duration-200 cursor-move
                    ${isDragging ? 'opacity-50 scale-105 rotate-2' : ''}
                    ${
                      isDropTarget
                        ? 'border-primary border-2 bg-primary/5'
                        : 'hover:border-primary/50'
                    }
                    ${index === 0 ? 'ring-2 ring-green-500' : ''}
                    ${disabled ? 'cursor-not-allowed' : 'cursor-move'}
                  `}
                >
                  {/* First image badge */}
                  {index === 0 && (
                    <div className="absolute -top-2 -left-2 z-10 bg-primary text-primary-foreground text-xs px-2 py-1 rounded-full font-medium">
                      Thumbnail
                    </div>
                  )}

                  {/* Drag handle */}
                  <div className="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                    <GripVertical className="h-4 w-4 text-muted-foreground bg-background/80 rounded p-0.5" />
                  </div>

                  {/* Delete button */}
                  <Button
                    className="absolute -top-2 -right-2 z-10 h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                    type="button"
                    onClick={() => onRemove(url)}
                    variant="destructive"
                    size="sm"
                  >
                    <Trash className="h-4 w-4" />
                  </Button>

                  <div className="relative aspect-square mb-2">
                    <Image
                      width={180}
                      height={180}
                      className="w-full h-full object-cover rounded-md"
                      alt={`Product image ${index + 1}`}
                      src={url}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground text-center">
                      Position: {index + 1}
                    </div>
                    <Input
                      className="h-8 text-xs"
                      placeholder="Photo credit"
                      value={credit}
                      onChange={(e) => handleCreditChange(url, e.target.value)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {isPublicDemoModeEnabled() ? (
        <Button
          type="button"
          disabled
          variant="outline"
          className="h-32 w-full border-2 border-dashed border-muted-foreground/25"
        >
          <div className="flex flex-col items-center space-y-2">
            <ImagePlus className="h-8 w-8 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Image upload disabled in read-only demo
            </span>
          </div>
        </Button>
      ) : blobConfigured ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleBlobFilesSelected}
          />
          <Button
            type="button"
            disabled={disabled || isUploading}
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="h-32 w-full border-2 border-dashed border-muted-foreground/25 hover:border-primary/50 transition-colors"
          >
            <div className="flex flex-col items-center space-y-2">
              <ImagePlus className="h-8 w-8 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {isUploading ? 'Uploading...' : 'Add Images'}
              </span>
            </div>
          </Button>
        </>
      ) : (
        <Button
          type="button"
          disabled
          variant="outline"
          className="h-32 w-full border-2 border-dashed border-muted-foreground/25"
        >
          <div className="flex flex-col items-center space-y-2">
            <ImagePlus className="h-8 w-8 text-muted-foreground" />
            <span className="text-sm text-muted-foreground text-center px-4">
              Image upload not configured — add a Blob store
            </span>
          </div>
        </Button>
      )}
    </div>
  )
}

export default ImageUpload
