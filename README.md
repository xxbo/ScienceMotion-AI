# ScienceMotion AI

An extensible creative framework for AI agents making science explainers and other complex videos. Build a platform that can discover, compose and govern hundreds of tools; templates remain optional accelerators, not the creative ceiling.

## Current status

| Stage | Implemented scope |
| --- | --- |
| P0 | Working Remotion, Mandarin TTS and MP4 CI pipeline; media polish remains open |
| P1.0 | Accepted local Project Graph, patch/revision operations, prefab/animation data and snapshots |
| P1.1-A–C | Local discovery, gateway, plugin lifecycle, execution records and content-addressed artifacts |
| P1.1-D | Local artifact references, project links/unlinks, reconciliation and garbage collection |
| P1.1-E | Multi-version plugin installation, one active version, pins, version locks, guarded switching and rollback |
| P1.2+ | Isolated workers, professional creative tools and the agent visual feedback loop are planned |

P1.1-E is a local implementation with focused tests. It is not a declaration that P1.1 as a whole is finished. See [the implementation and acceptance notes](docs/P1.1-E.md) for tested boundaries.

The geometry tool and plugin JSON files are catalogue fixtures. Their presence does not mean a complete executable geometry plugin or generic Project Graph video renderer has been delivered.

## Development checks

Node.js 22 is used by CI.

```bash
npm install
npm run typecheck
npm test
npm run validate:episode
npm run validate:project
npm run validate:project-patch
npm run validate:tool-manifests
npm run validate:plugin-manifests
npm run render:storyboard
```

`npm run studio` and `npm run render` also generate narration and require the Python voice environment described by the repository's voice scripts and CI workflow.

## Design

Editorial content and animation/rendering stay separate. P1.0's Project Graph is the common data model. P1.1 supplies tool manifests, registry, gateway, plugins, execution records and artifact references. Specialist renderers and workers will consume approved snapshots through explicit contracts.

Read [Platform Vision](docs/PLATFORM_VISION.md), [Development Plan](docs/PLAN.md), [Architecture](docs/ARCHITECTURE.md), and [P1.1-E](docs/P1.1-E.md).
