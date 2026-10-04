import { getRequestConfig } from "next-intl/server";
export default getRequestConfig(async ({requestLocale}) => {
 const requested=await requestLocale;
 const locale=requested==="en"?"en":"et";
 return {locale,messages:(await import(`../../messages/${locale}.json`)).default,timeZone:"Europe/Tallinn"};
});
