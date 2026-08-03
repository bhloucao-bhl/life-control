export const metadata = {
  title: 'Life Control',
  description: 'Centro de controle da vida',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Life Control' },
  icons: {
    icon: [{ url: '/icon?v=3', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/apple-icon?v=3', sizes: '180x180', type: 'image/png' }],
  },
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
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossOrigin="" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossOrigin="" async></script>
        <style>{`
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #0B0B0F; color: #ECECEF; font-family: 'Outfit', system-ui, -apple-system, sans-serif; }
          body { -webkit-font-smoothing: antialiased; overscroll-behavior-y: none; }
          input, textarea, select, button { font-family: inherit; }
          @keyframes lccPulse { 0%,100% { opacity: .35; transform: scale(0.97); } 50% { opacity: 1; transform: scale(1.03); } }
          .lcc-pulse { animation: lccPulse 1.4s ease-in-out infinite; }
          .lcc-tip { background: rgba(11,11,15,.85) !important; border: none !important; color: #F5C263 !important; font-size: 10px !important; font-weight: 700 !important; box-shadow: none !important; padding: 1px 5px !important; }
          .lcc-tip::before { display: none !important; }
          .leaflet-container { font-family: 'Outfit', sans-serif !important; background: #0b1018 !important; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
