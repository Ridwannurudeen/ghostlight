# Ghostlight performance profile

Measured on 2026-08-23 from the generated GLB JSON chunks and the entity creation paths in `src/client`.
This is a deterministic authored-scene profile, not a substitute for the Android and iOS renderer counters in
`docs/DEVICE-CHECKLIST.md`.

## Profile scenario

The at-rest baseline is one initialized client after platform detection, with the complete theater, all eight
ghost slots allocated, three virtual cameras, and all eleven audio sources created. No reward prop is attached
and no correct reveal has yet allocated its floating verdict entity. The reveal measurement is the peak of a
correct reveal at the 2.6-second verdict beat. UI-tree nodes, SDK-reserved entities, the local player, and
profile-dependent avatar and wearable geometry are outside these authored ECS and GLB counts.

| State | App-created ECS entities | GLB instances | Authored GLB triangles | Instantiated GLB material slots | Live material overrides |
|---|---:|---:|---:|---:|---:|
| At rest, before the first correct reveal | 44 | 21 | 11,664 | 60 | 7 |
| Correct reveal peak | 45 | 21 | 11,664 | 60 | 7 |
| At rest after a correct reveal | 45 | 21 | 11,664 | 60 | 7 |

The 44 baseline entities are 22 theater entities (21 GLB containers plus the marquee text), eight preallocated
ghost-slot entities, three camera entities, and eleven audio-source entities. A correct reveal lazily creates
one floating `TextShape` entity. Its text component is removed after the animation, but the entity is retained
for reuse, which is why the subsequent at-rest count remains 45. A wrong reveal does not allocate it.

The seven `GltfNodeModifiers` material overrides belong to the marquee, chandelier, four footlights, and
spotlight. Reveal mood changes replace those seven overrides; they do not create more GLB instances, material
slots, or entities. Renderer-generated `TextShape` geometry is not reported as authored GLB triangles.

## Avatar and reward variants

The eight ghost entities are allocated once. At maximum occupancy they hold one performer, five audience
members, the Ghost of the Night on the sixth audience slot, and one duet replier on the preview slot: exactly
eight active `AvatarShape` components. The pedestal and replier therefore coexist without a ninth avatar.
Avatar body shapes, wearables, and emotes come from player profiles, so their renderer triangles and materials
cannot be represented by a deterministic authored-asset number.

Each in-scene titled avatar tracked by the reward controller adds two ECS entities (an avatar anchor and a
child prop), one GLB instance, three instantiated material slots, and the following authored geometry:

| Title | Prop | Added triangles |
|---|---|---:|
| Understudy | `prop_tophat.glb` | 208 |
| Scene Stealer | `prop_mask.glb` | 216 |
| Ghostlight Legend | `prop_trophy.glb` | 284 |

The live-player controller retains at most the 16 nearest titled players, refreshing distance order once per
second. The current performer uses one additional reusable stage-reward slot when its author is not already
represented by the live-player pool. At the conservative peak where all 16 retained players and the stage author
use the 284-triangle trophy, a correct reveal has 79 app-created ECS entities, 38 GLB instances, 16,492 authored
triangles, and 111 instantiated material slots. Two declared parcels allow 400 entities and 20,000 triangles.
Later visitors replace farther pooled rewards, and stage-author history reuses its single slot, so neither path
accumulates entities or models without bound.

## Asset-library totals

The complete generated library contains 15 unique GLBs and 6,324 triangles. Those self-contained files encode
42 material definitions, representing five unique authored material names. The theater uses 12 distinct GLB
sources; repeated seat rows, poster frames, and footlights bring the live theater to 21 instances, 11,664
triangle instances, and 60 instantiated material slots. These are deliberately separate metrics: summing the
unique library once understates instancing cost, while summing material slots does not mean there are 60 unique
materials.

The largest model is `marquee.glb` at 1,084 triangles. Every GLB has at most three material definitions, and
the complete `assets/` directory is 877,471 bytes. The generated model payload is 437,296 bytes, sounds are
317,539 bytes, and UI PNG payloads are 82,395 bytes; directory totals also include manifests and the scene
composite.

## Measurement and reproducibility

- GLB triangle counts come from indexed primitive accessors in each generated GLB JSON chunk, using the same
  method enforced by `test/asset-budget.test.ts` and recorded in `assets/models/manifest.json`.
- Scene totals multiply each model's measured triangles and material definitions by the exact instance counts
  in `createTheater()`: six seat rows, two poster frames, four footlights, and one of each other theater model.
- The budget test reads the runtime reward cap and includes the additional stage slot. The 16,492-triangle and
  79-entity conservative peaks must fit the two-parcel limits.
- Entity totals trace every `engine.addEntity()` reached by `main()` after platform setup. They count allocated
  entities even when an optional component is temporarily absent.
- Generation used Blender 5.1.2, Python 3.12.10, NumPy 2.4.6, SciPy 1.18.0, Pillow 12.2.0, and FFmpeg 8.1.2.
- Two consecutive `npm run assets:sounds` executions both exited 0. SHA-256 comparison covered all 12 sound
  outputs; zero hashes changed between the runs.
- Room tone decodes to exactly 529,200 samples (12 seconds). Its decoded loop seam is -31.215 dBFS and 0.339 of
  the 99th-percentile interior sample delta; every MP3 manifest peak is measured from encoded, decoded output.

The remaining performance gate is the owner-run mobile pass: confirm greater than 90% Performance on the Galaxy
A54 High profile while the full eight-avatar stress configuration and reveal choreography are visible.
