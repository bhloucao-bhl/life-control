/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // expõe o sha do commit implantado (Vercel injeta VERCEL_GIT_COMMIT_SHA no build) pro app
  // conseguir mostrar, em Ajustes, qual versão está no ar — dá pra comparar com o GitHub.
  env: { GIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || '' },
};
module.exports = nextConfig;
