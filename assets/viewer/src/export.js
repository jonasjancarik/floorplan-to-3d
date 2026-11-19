// Writes the flat as a .glb file for Unreal, Blender and the like.
//
// The viewer draws everything of one material as a single finely divided mesh. For other
// programs the model is put together differently: one named node per element (a window,
// a door frame, a chair) holding plain, undivided geometry, with door leaves kept as nodes
// that turn about their hinges. Metres, +Y up, north towards -Z. Light is not included.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeAll } from './geometry.js';

const LEFT_OUT = new Set(['wallCut']);          // the dark cut face on top of the walls is a viewer device

export async function exportFlat(sections, materials) {
  const copies = new Map();
  // A plain copy of a material; texture tiling is written into the texture coordinates,
  // so the file needs no extension for it.
  const materialFor = key => {
    if (!copies.has(key)) {
      const source = materials[key], copy = new THREE.MeshStandardMaterial();
      for (const name of ['color', 'roughness', 'metalness', 'transparent', 'opacity', 'side']) {
        copy[name] = source[name]?.clone ? source[name].clone() : source[name];
      }
      const tiling = source.map?.repeat.clone() ?? source.normalMap?.repeat.clone() ?? new THREE.Vector2(1, 1);
      for (const name of ['map', 'normalMap', 'roughnessMap']) {
        if (!source[name]) continue;
        copy[name] = source[name].clone();
        copy[name].repeat.set(1, 1);
      }
      if (source.normalMap) copy.normalScale.copy(source.normalScale);
      copy.name = key;
      copies.set(key, { copy, tiling });
    }
    return copies.get(key);
  };
  const meshFor = (key, geos, name) => {
    const { copy, tiling } = materialFor(key);
    const geometry = mergeAll(geos.map(g => g.clone()));
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * tiling.x, uv.getY(i) * tiling.y);
    const mesh = new THREE.Mesh(geometry, copy);
    mesh.name = name;
    return mesh;
  };
  // Rebuilds what a Batch built, element by element; groups built by a Batch further down
  // (the door leaves) keep their own place and turn.
  const rebuild = (object, name) => {
    const out = new THREE.Group();
    out.name = name;
    out.position.copy(object.position);
    out.quaternion.copy(object.quaternion);
    const parts = object.userData.parts ?? new Map();
    for (const [part, byMaterial] of parts) {
      const keys = [...byMaterial.keys()].filter(key => !LEFT_OUT.has(key));
      if (!keys.length) continue;
      // An object that is one element (a door leaf) holds its meshes directly; otherwise each
      // element gets a node of its own. Meshes are named after the element and, where an
      // element has several materials, the material.
      const label = parts.size === 1 ? name : part;
      const holder = parts.size === 1 || keys.length === 1 ? out : new THREE.Group();
      if (holder !== out) { holder.name = label; out.add(holder); }
      for (const key of keys) holder.add(meshFor(key, byMaterial.get(key), keys.length === 1 ? label : `${label}--${key}`));
    }
    for (const child of object.children) if (child.userData.parts) out.add(rebuild(child, child.name));
    return out;
  };

  const root = new THREE.Group();
  root.name = 'melnicka-flat';
  root.userData = { units: 'metres', up: '+Y', north: '-Z', note: 'Built from out/melnicka-floorplan.json; doors are in the position shown in the viewer.' };
  for (const [name, object] of Object.entries(sections)) root.add(rebuild(object, name));
  return new GLTFExporter().parseAsync(root, { binary: true });
}
