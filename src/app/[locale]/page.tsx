import { notFound } from 'next/navigation';
export default async function Page({params}: {params: Promise<{locale: string}>}) {
  const {locale} = await params;
  if (!['et', 'en'].includes(locale)) notFound();
  return <main><h1>Kontroll</h1><p>Auto24 listing dashboard foundation.</p></main>;
}
