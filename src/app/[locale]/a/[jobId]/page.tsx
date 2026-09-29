import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { jobIdSchema } from '../../../../listings/contracts';
import { cookieName, verifyAccess } from '../../../../server/access';
export default async function Page({params}: {params: Promise<{locale: string; jobId: string}>}) {
  const {locale, jobId} = await params;
  if (!['et', 'en'].includes(locale) || !jobIdSchema.safeParse(jobId).success || !verifyAccess(jobId, (await cookies()).get(cookieName(jobId))?.value)) notFound();
  return <main><h1>Kontroll</h1><p>Private dashboard foundation: {jobId}</p></main>;
}
