import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import { themeBootstrap } from '../lib/theme';
export const metadata: Metadata={title:'swooshit — private file transfer',description:'Instant browser-to-browser file transfer',icons:{icon:{url:'/swooshit-logo.svg',type:'image/svg+xml'},shortcut:'/swooshit-logo.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en" data-theme="light" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeBootstrap}} /></head><body>{children}<Analytics /></body></html>}
