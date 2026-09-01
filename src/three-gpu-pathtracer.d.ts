declare module 'three-gpu-pathtracer' {
  import type * as THREE from 'three'

  export class PathTracingRenderer {
    camera:  THREE.Camera
    alpha:   boolean
    samples: number
    target:  THREE.WebGLRenderTarget
    material: PhysicalPathTracingMaterial
    constructor(renderer: THREE.WebGLRenderer)
    setSize(w: number, h: number): void
    update(): void
    reset(): void
    dispose(): void
  }

  export class PhysicalPathTracingMaterial {
    environmentIntensity: number
    bvh:                    { updateFrom(bvh: unknown): void }
    attributesArray:        { updateFrom(n: THREE.BufferAttribute, t: THREE.BufferAttribute, uv: THREE.BufferAttribute, c: THREE.BufferAttribute): void }
    materialIndexAttribute: { updateFrom(attr: THREE.BufferAttribute): void }
    textures:               { setTextures(renderer: THREE.WebGLRenderer, w: number, h: number, textures: THREE.Texture[]): void }
    materials:              { updateFrom(materials: THREE.Material[], textures: THREE.Texture[]): void }
    lights:                 { updateFrom(lights: THREE.Light[]): void }
    envMapInfo:             { updateFrom(texture: THREE.Texture): void }
  }

  export class DynamicPathTracingSceneGenerator {
    geometry:  THREE.BufferGeometry
    materials: THREE.Material[]
    textures:  THREE.Texture[]
    lights:    THREE.Light[]
    constructor(scene: THREE.Object3D | THREE.Object3D[])
    generate(): {
      bvh:       unknown
      textures:  THREE.Texture[]
      materials: THREE.Material[]
      lights:    THREE.Light[]
    }
    reset(): void
    dispose(): void
  }

  export class PathTracingSceneGenerator {
    generate(scene: THREE.Object3D, options?: Record<string, unknown>): {
      bvh:       unknown
      textures:  THREE.Texture[]
      materials: THREE.Material[]
      lights:    THREE.Light[]
    }
  }
}
