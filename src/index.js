const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  saveFiles,
  log
} = require('cozy-konnector-libs')
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very useful for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})
var cache = [];
const baseUrl = 'https://eticket-app.qiis.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of documents')
  const $ = await request(`${baseUrl}/famille/factures/`)
  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  log('info', 'Parsing list of documents')

  var documents = [];
  
  documents = await parseDocuments($)

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['etickets']
  });


  // recuperation des attestations fiscales
  documents = parseAttestationsFiscales($)
  log('info','Saving tax data to Cozy');

  await saveFiles(documents, fields, {
      timeout: Date.now () + 300 * 1000
    });
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  return signin({
    url: `https://eticket.qiis.fr/`,
    formSelector: 'form',
    formData: {email: username,password: password },
    // the validate function will check if the login request was a success. Every website has
    // different ways respond: http status code, error message in html ($), http redirection
    // (fullResponse.request.uri.href)...
    validate: (statusCode, $, fullResponse) => {
      log(
        'debug',
        fullResponse.request.uri.href,
        'not used here but should be usefull for other connectors'
      )
      // The login in toscrape.com always works excepted when no password is set
      if ($(`a[href='/logout']`).length === 1) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', $('.error').text())
        return false
      }
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseDocuments($) {
  // you can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      title: {
        sel: 'td:nth-child(3)'
      },
      amount: {
        sel: 'td:nth-child(4)',
        parse: normalizePrice
      },
      filename:{
        sel: 'td:nth-child(2)',
        parse: name => `${name}.pdf`
      },
      fileurl: {
        sel: 'td:nth-child(5) a',
        attr: 'href',
        parse: src => `${baseUrl}/famille/factures/${src}`
      },
      date: {
        sel: 'td:nth-child(1)'
      },
      reference: {
       sel: 'td:nth-child(2)'
      }
    },
    '#PANEL table tbody tr:not(.facture_header)'
  )

  return docs.map(doc => ({
    ...doc,
    // the saveBills function needs a date field
    // even if it is a little artificial here (these are not real bills)
    date: normalizeDate(doc.date),
    currency: '€',
    vendor: 'eTickets',
    metadata: {
      // it can be interesting that we add the date of import. This is not mandatory but may be
      // useful for debugging or data migration
      importDate: new Date(),
      // document version, useful for migration after change of document structure
      version: 1
    }
  }))
}

// convert a price string to a float
function normalizePrice(price) {
  price = price.replace(new RegExp(' ', 'g'),'');
  price = price.replace(new RegExp(',', 'g'),'.');

  price = price.trim();
  return parseFloat(price)
}

// "Parse" the date found in the bill page and return a JavaScript Date object.
function normalizeDate(date) {

 const [day, month, year] = date.split('/')

 sDate = '20' + year.trim() +'-' + month.trim() +'-' + day.trim();

 return new Date(sDate)
}


function parseAttestationsFiscales($)
{
  var tabLiens = $('#PANEL>a');
  var documents= [];
  log('info',tabLiens.length);
  for (i=0;i < tabLiens.length; i++)
  {

    sTitre = tabLiens[i].children[0].data;

    sTitre = 'Attestation_fiscale_' + normalizeTitre(sTitre.trim());

    sFileURL = baseUrl + '/famille/factures/' + tabLiens[i].attribs.href;
    sFileName = sTitre + '.pdf'

    documents.push({title:sTitre,fileurl:sFileURL, filename:sFileName});

  }

  return documents;

}
function normalizeTitre(sTitle)
{
 log('info','titre :' + sTitle);

  var regex1 = new RegExp('[0-9]+','y');
  if (regex1.test(sTitle))
    return sTitle;
  else
    return (new Date()).getFullYear();

}
