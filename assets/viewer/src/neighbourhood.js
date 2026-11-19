// The real street and courtyard around the flat, cut out of IPR's 3D photo model of Prague
// by build_surroundings.py (data base © IPR Praha, CC BY 4.0). The file is already in the
// viewer's coordinates. It holds the photo-textured surroundings, which are only looked at,
// and `blockers`, plain shapes with a colour at each corner, which the light is worked out
// against: they hide the sun and the sky where the real houses do. The fronts seen most from the
// windows are flat walls named `front-N` with a redrawn picture each (build_fronts.py); they are
// drawn and lit like the rest.
import * as THREE from 'three/webgpu';
import { Discard, Fn, cameraPosition, positionWorld, texture, uniform } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const SEEN = 0.12;          // how bright the photos are drawn by day, against the light indoors

// Starts the download. Called first thing, so that the file comes in while the flat is
// being built. Resolves to null when the file is not there (the development server answers
// a missing file with the page itself), so that the viewer can fall back on made-up houses.
export function fetchNeighbourhood(url) {
  return fetch(url).then(r => r.ok && !r.headers.get('content-type')?.includes('html') ? r.arrayBuffer() : null, () => null);
}

// Turns the downloaded file into the scenery and the shapes for the light.
// The photos come as KTX2 (Basis Universal), which the graphics card keeps compressed; the
// transcoder that unpacks them is served at /basis/ (see vite.config.js).
export async function loadNeighbourhood(file, centre, renderer) {
  if (!file) return null;
  const photos = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
  const gltf = await new GLTFLoader().setKTX2Loader(photos).parseAsync(file, '');
  photos.dispose();
  const group = gltf.scene.getObjectByName('surroundings'), blockers = gltf.scene.getObjectByName('blockers');
  const level = uniform(SEEN), opened = uniform(0), middle = uniform(new THREE.Vector3(centre.x, 1.5, centre.z));
  const maps = new Set();
  group.traverse(o => {
    if (!o.isMesh) return;
    const map = o.material.map, material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    // Seen from above, whatever stands between the eye and the flat is left out: a cone
    // from the eye that is `opened` metres wide at the flat, and anything right in front
    // of the eye. The roof and the floors above go, and the rest of the town stays whole.
    material.colorNode = Fn(() => {
      const toFlat = middle.sub(cameraPosition), reach = toFlat.length(), toHere = positionWorld.sub(cameraPosition);
      const along = toHere.dot(toFlat.div(reach)), aside = toHere.sub(toFlat.mul(along.div(reach))).length();
      Discard(positionWorld.y.greaterThan(-0.4).and(along.lessThan(reach)).and(aside.lessThan(opened.mul(along.div(reach))).or(toHere.length().lessThan(opened))));
      return texture(map).rgb.mul(level);
    })();
    o.material = material;
    maps.add(map);
    o.updateMatrix();         // the corners are stored as 16-bit numbers, turned back into metres by the node's scale
    o.matrixAutoUpdate = false;
    o.layers.set(1);          // drawn in the picture, left out of the pass that works out contact shading
  });
  blockers.geometry.computeVertexNormals();
  return {
    group, blockers, level, maps: [...maps],
    setDaylight(day) { level.value = SEEN * day; },
    // how wide the opening towards the flat is, in metres at the flat; 0 closes it
    open(radius) { opened.value = radius; },
  };
}
