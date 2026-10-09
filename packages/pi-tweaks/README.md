# @zigai/pi-tweaks

Install the ordered collection with `pi install npm:@zigai/pi-tweaks`.

The collection references its bundled, independently published extension dependencies through Pi's supported `node_modules` resource paths. Each extension retains its own entrypoint, identity, settings, license, and version; there is no combined factory or copied source workspace. Do not enable this collection alongside its individual extensions.

The manifest's `pi.extensions` is the authoritative activation order. Original extensions retain their established order; imported extensions follow the local package ordering recorded during migration, with expanded skills appended. Installing this collection explicitly enables all 24 extensions. The migration does not enable previously inactive extensions in personal settings.

Release versions are independent. Updating the collection requires updating its exact dependency pins and resource paths, then verifying its installed tarball. `npm run build` at the repository root builds dependency artifacts and stages local tarballs for the collection. `npm pack -w @zigai/pi-tweaks` runs the same prerequisite build through prepack; bundling is required so the declared resource paths exist regardless of npm hoisting.
