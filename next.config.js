/** @type {import('next').NextConfig} */
// Nº do PR mergeado que gerou este deploy: a Vercel injeta VERCEL_GIT_COMMIT_MESSAGE no build,
// e o merge padrão do GitHub (squash ou merge commit) sempre inclui "(#123)" na mensagem.
const prMatch = /\(#(\d+)\)/.exec(process.env.VERCEL_GIT_COMMIT_MESSAGE || '');

const nextConfig = {
  reactStrictMode: true,
  // expõe o sha do commit e o nº do PR implantados pro app conseguir mostrar, em Ajustes,
  // qual versão está no ar — dá pra comparar com o GitHub.
  env: {
    GIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || '',
    GIT_PR: prMatch ? prMatch[1] : '',
  },
};
module.exports = nextConfig;
