export const metadata = {
  title: 'Life Control',
  description: 'Centro de controle da vida',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Life Control' },
};

export const viewport = {
  themeColor: '#0B0B0F',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <head>
        <style>{`
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #0B0B0F; color: #ECECEF; }
          body { -webkit-font-smoothing: antialiased; overscroll-behavior-y: none; }
          input, textarea, select, button { font-family: inherit; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
