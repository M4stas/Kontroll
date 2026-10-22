import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, expect, it } from 'vitest';
import { BackgroundCheckLine } from '@/features/report/background-check';
import en from '../../../messages/en.json';
import et from '../../../messages/et.json';
afterEach(cleanup);
it.each([
 ['en','pending','Checking…'],['en','fetched','PDF ready'],['en','not_found','Not in the register'],['en','skipped','No reg number or VIN to search with'],['en','unavailable','Unavailable'],['en','not_started','Not started'],['en','not_requested','Not started'],
 ['et','pending','Kontrollimine…'],['et','fetched','PDF valmis'],['et','not_found','Registrist ei leitud'],['et','skipped','Otsimiseks puudub registreerimisnumber või VIN'],['et','unavailable','Pole saadaval'],['et','not_started','Alustamata'],['et','not_requested','Alustamata'],
] as const)('renders %s %s background check', (locale,status,label)=>{
 render(<NextIntlClientProvider locale={locale} messages={locale==='en'?en:et}><BackgroundCheckLine backgroundCheck={{status,reason:null,...(status==='fetched'?{pdfUrl:'/private.pdf',fetchedAt:'2026-10-22T12:00:00Z'}:{})}}/></NextIntlClientProvider>);
 expect(screen.getByText(label)).toBeVisible();
 if(status==='fetched') expect(screen.getByRole('link',{name:label})).toHaveAttribute('href','/private.pdf');
 if(status==='pending') expect(screen.getByRole('status')).toHaveAttribute('aria-busy','true');
});
it('omits the background check for old reports',()=>{
 const {container}=render(<NextIntlClientProvider locale="en" messages={en}><BackgroundCheckLine/></NextIntlClientProvider>);
 expect(container).toBeEmptyDOMElement();
});
it.each([
 ['en','captcha_failed','CAPTCHA could not be completed'],['en','blocked','Service blocked the request'],['en','timeout','Check timed out'],['en','pdf_rejected','PDF could not be verified'],['en','site_changed','Service page changed'],['en','browser_crash','Browser stopped'],
 ['et','captcha_failed','CAPTCHA lahendamine ebaõnnestus'],['et','blocked','Teenus blokeeris päringu'],['et','timeout','Kontroll aegus'],['et','pdf_rejected','PDF-i ei saanud kinnitada'],['et','site_changed','Teenuse leht on muutunud'],['et','browser_crash','Brauser peatus'],
] as const)('explains %s unavailable %s', (locale,reason,label)=>{
 render(<NextIntlClientProvider locale={locale} messages={locale==='en'?en:et}><BackgroundCheckLine backgroundCheck={{status:'unavailable',reason}}/></NextIntlClientProvider>);
 expect(screen.getByText(`(${label})`)).toBeVisible();
});
