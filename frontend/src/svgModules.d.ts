// frontend/src/svgModules.d.ts
//
// An imported `.svg` is a URL the bundler gives for the file, unmodified (CRA's asset loader; Jest's file transform gives
// its basename). Used for Keplr's official brand files (`components/money/brand/`), which are shown as `<img>` only.
declare module "*.svg" {
  const src: string;
  export default src;
}
