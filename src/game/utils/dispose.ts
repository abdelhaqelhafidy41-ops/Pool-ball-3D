import * as THREE from 'three';

function disposeMaterial(material: THREE.Material) {
  const mat = material as unknown as Record<string, unknown>;
  const mapKeys = [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
    'bumpMap',
    'displacementMap',
    'alphaMap',
    'clearcoatMap',
    'clearcoatRoughnessMap',
    'clearcoatNormalMap',
    'envMap',
  ];

  for (const key of mapKeys) {
    const tex = mat[key];
    if (tex && tex instanceof THREE.Texture) {
      tex.dispose();
    }
  }
  material.dispose();
}

export function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points) {
      if (obj.geometry) {
        obj.geometry.dispose();
      }
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(disposeMaterial);
        } else {
          disposeMaterial(obj.material);
        }
      }
    }
  });
}
