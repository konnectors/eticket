process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://d66cb6d5d0f74423a877aff49f2b170a@sentry.cozycloud.cc/107'

/* eslint no-constant-condition: off */

const {
  BaseKonnector,
  requestFactory,
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
var WebSocketClient = require('websocket').client
const stream = require('stream')

const UrlWebsocket =
  'wss://s-usc1c-nss-394.firebaseio.com/.ws?v=5&ns=qiis-eticket-production'

class eTicketKonnector extends BaseKonnector {
  constructor() {
    super()
    this.request = requestFactory({
      // debug: 'json',
      cheerio: false,
      json: true,
      jar: true
    })
    this.wsClient = new WebSocketClient()
    this.metaManagerId = '' // Identifiant client
    this.familyID = ''
    this.customToken = '' // le token personnalisé
    this.tokenId = '' // Le token d'identification
    this.wsConnection = null
    this.numQuestion = 0

    // Configure le websocket
    this._ConfigureWebsocket()

    // Evénéments que l'on doit gérer pour le websocket
    this.webSocketConnecte = false
    this.webSocketErreurConnexion = false
    this.webSocketAuthentifie = false
    this.documentsRecuperes = false
    this.documents = []
    this.taAnswer = []
    this.nbPaquetsAttendus = 0
    this.dernierPaquet = ''
  }

  // The start function is run by the BaseKonnector instance only when it got all the account
  // information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
  // the account information come from ./konnector-dev-config.json file
  async fetch(fields) {
    log('info', 'Authenticating ...')

    await this.authenticate(fields.login, fields.password)

    log('info', 'Successfully logged in')
    // The BaseKonnector instance expects a Promise as return of the function
    log('info', 'Fetching the list of documents')
    // On crée la websocket client

    // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
    log('info', 'Parsing list of documents')

    var documents = []

    documents = await this.parseBills()

    // here we use the saveBills function even if what we fetch are not bills, but this is the most
    // common case in connectors
    log('info', 'Saving data to Cozy')
    await saveBills(documents, fields, {
      // this is a bank identifier which will be used to link bills to bank operations. These
      // identifiers should be at least a word found in the title of a bank operation related to this
      // bill. It is not case sensitive.
      identifiers: ['etickets']
    })

    // recuperation des documents divers
    documents = await this.parseDocuments()
    log('info', 'Saving documents to Cozy')

    await saveFiles(documents, fields, {
      timeout: Date.now() + 300 * 1000,
      validateFile: function() {
        return true
      }
    })

    // On se déconnecte
    this.wsConnection.close()
  }

  async authenticate(username, password) {
    // On se connecte
    var options = {
      uri:
        'https://eticket-app.qiis.fr/api/v1/auth/login?login=' +
        username +
        '&password=' +
        password +
        '&requestFirebaseCustomToken=true',
      method: 'GET'
    }

    // On s'identifie
    await this.request(
      options,
      function(error, response, body) {
        if (body.status == 'Success') {
          // Sauvegarde des informations nécessaires
          // Le token d'identification
          log('debug', 'récupération du token')
          this.customToken = body.firebaseCustomToken
        }
      }.bind(this)
    )

    // On échange le token avec un token d'identification
    options = {
      uri:
        'https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyCustomToken?key=AIzaSyDERcRUv900BN5lb4TIAFooo2aoqu4T32c',
      method: 'POST',
      json: {
        returnSecureToken: true,
        token: this.customToken
      }
    }
    await this.request(
      options,
      function(error, response, body) {
        if (!error && response.statusCode == 200) {
          // Sauvegarde des informations nécessaires
          // Le token d'identification
          this.tokenId = body.idToken
        }
      }.bind(this)
    )

    // On se connecte au websocket
    this.wsClient.connect(UrlWebsocket)

    // attend la connexion
    await this._WaitForConnection()

    // on envoie l'authentification
    var oJSON = {
      t: 'd',
      d: {
        r: this.NouveauNumeroQuestion(),
        a: 'auth',
        b: {
          cred: this.tokenId
        }
      }
    }
    // Envoie les infos de connexion
    this._EnvoieMessageWS(oJSON)

    // Attend la réponse à la question
    await this._WaitForAnswer(this.NumeroQuestionEnCours())

    // Récupère la réponse à la question en cours
    oJSON = JSON.parse(this.taAnswer[this.NumeroQuestionEnCours()])

    // Parse des infos du compte
    this.metaManagerId = oJSON.d.b.d.auth.metaManagerId
    this.familyID = oJSON.d.b.d.auth.familyId
  }
  NouveauNumeroQuestion() {
    this.numQuestion++
    return this.numQuestion
  }

  NumeroQuestionEnCours() {
    return this.numQuestion
  }

  _EnvoieMessageWS(oJSON) {
    // Vide le dernier message reçu
    this.dernierPaquet = ''
    // envoi d'un message
    log('info', 'Envoi du message : ' + JSON.stringify(oJSON))
    this.wsConnection.send(JSON.stringify(oJSON))
  }
  _ConfigureWebsocket() {
    this.wsClient.on(
      'connectFailed',
      function(error) {
        this.webSocketErreurConnexion = true
        log('error', 'Connect Error: ' + error.toString())
      }.bind(this)
    )

    this.wsClient.on(
      'connect',
      function(connection) {
        log('debug', 'WebSocket Client Connected')
        this.wsConnection = connection
        this.webSocketConnecte = true

        connection.on('error', function(error) {
          log('error', 'Connection Error: ' + error.toString())
        })

        connection.on(
          'close',
          function() {
            log('info', 'Connection Closed')
            this.webSocketConnecte = false
          }.bind(this)
        )

        connection.on(
          'message',
          function(message) {
            if (message.type === 'utf8') {
              log('debug', "Received: '" + message.utf8Data + "'")

              // on récupère le json
              if (this.nbPaquetsAttendus > 0) {
                log(
                  'debug',
                  'On attend un nombre de paquet défini, on ajoute ce paque au dernier reçu'
                )

                // On ajoute le message reçu aux paquet reçus
                this.dernierPaquet += message.utf8Data
                this.nbPaquetsAttendus--
              } else {
                log('debug', 'Pas de nombre de paquet précis attendu')
                var oJSON = JSON.parse(message.utf8Data)
                if (oJSON.d && 'r' in oJSON.d) {
                  log(
                    'debug',
                    'On a un numéro de question, donc on va stocker toute les réponses dans ce numéro de question'
                  )
                  // on stocke le résultat
                  if (this.dernierPaquet == '') {
                    log('debug', 'Stocke le message reçu')
                    this.taAnswer[oJSON.d.r] = message.utf8Data
                  } else {
                    log('debug', 'Stocke le dernier message reçu')
                    this.taAnswer[oJSON.d.r] = this.dernierPaquet
                    this.dernierPaquet = ''
                  }
                } else {
                  if (parseInt(message.utf8Data) > 0) {
                    // c'est le nombre de paquets qu'on attend
                    this.nbPaquetsAttendus = parseInt(message.utf8Data)
                  } else {
                    // C'est que c'est une réponse JSON directement
                    this.dernierPaquet = message.utf8Data
                  }
                }
              }
            }
          }.bind(this)
        )
      }.bind(this)
    )
  }
  // First define some delay function which is called from async function
  __delay__(timer) {
    return new Promise(resolve => {
      const _timer = timer || 2000
      setTimeout(function() {
        resolve()
      }, _timer)
    })
  }
  async _WaitForAnswer(nIDResponse) {
    log('debug', 'Attente de la réponse ' + nIDResponse)
    while (true) {
      if (nIDResponse in this.taAnswer) {
        log('debug', 'réponse trouvée')
        break
      }
      log('debug', 'attente 1s')
      await this.__delay__(1000)
    }
  }

  async _WaitForConnection() {
    log('debug', 'Attente de la connexion')
    while (this.webSocketConnecte == false) {
      if (this.webSocketErreurConnexion) {
        log('error', 'Une erreur s est produite')
        return
      }
      await this.__delay__(1000)
    }

    log('debug', 'La connection est faite... : ' + this.webSocketConnecte)
  }

  async parseBills() {
    var oJSON = {
      t: 'd',
      d: {
        r: this.NouveauNumeroQuestion(),
        a: 'q',
        b: {
          p:
            '/meta/' +
            this.metaManagerId +
            '/family/' +
            this.familyID +
            '/invoice',
          h: ''
        }
      }
    }

    // Envoie la demande de factures
    this._EnvoieMessageWS(oJSON)

    // attend la réponse
    await this._WaitForAnswer(this.NumeroQuestionEnCours())

    // On a les factures
    log(
      'debug',
      'Réponse reçue pour les factures : ' +
        this.taAnswer[this.NumeroQuestionEnCours()]
    )

    var documents = []

    // Parcours des factures
    var oJSONFactures = JSON.parse(this.taAnswer[this.NumeroQuestionEnCours()])
    oJSONFactures = oJSONFactures.d.b.d
    for (const IDFacture in oJSONFactures) {
      if (!oJSONFactures.hasOwnProperty(IDFacture)) {
        continue
      }

      var oUneFacture = oJSONFactures[IDFacture]

      // Est ce qu'on a une pièce jointe
      if (!oUneFacture.hasOwnProperty('attachment')) {
        continue
      }

      //
      var oDocument = {
        title: oUneFacture.body.label,
        amount: parseInt(oUneFacture.body.totalAmountTTCCent) / 100,
        date: new Date(oUneFacture.body.invoiceDate),
        reference: oUneFacture.body.reference,
        fileurl: oUneFacture.attachment.url,

        // the saveBills function needs a date field
        // even if it is a little artificial here (these are not real bills)
        currency: '€',
        vendor: 'eTickets',
        filename: this.normalizeFileName(
          new Date(oUneFacture.body.invoiceDate),
          parseInt(oUneFacture.body.totalAmountTTCCent) / 100,
          oUneFacture.body.reference
        ),
        metadata: {
          // it can be interesting that we add the date of import. This is not mandatory but may be
          // useful for debugging or data migration
          importDate: new Date(),
          // document version, useful for migration after change of document structure
          version: 1
        }
      }

      documents.push(oDocument)
    }

    return documents
  }

  normalizeFileName(dDate, mMontant, sReference) {
    /* 2018-01-02_edf_35.50€_345234.pdf
YYYY-MM-DD_vendor_amount.toFixed(2)currency_reference.pdf
*/
    return (
      this.formatDate(dDate) +
      '_eTickets_' +
      mMontant +
      '€_' +
      sReference +
      '.pdf'
    )
  }
  // Convert a Date object to a ISO date string
  formatDate(date) {
    let year = date.getFullYear()
    let month = date.getMonth() + 1
    let day = date.getDate()
    if (month < 10) {
      month = '0' + month
    }
    if (day < 10) {
      day = '0' + day
    }
    return `${year}-${month}-${day}`
  }

  async parseDocuments() {
    var oJSON = {
      t: 'd',
      d: {
        r: this.NouveauNumeroQuestion(),
        a: 'q',
        b: {
          p:
            '/meta/' +
            this.metaManagerId +
            '/family/' +
            this.familyID +
            '/document/native',
          h: ''
        }
      }
    }

    // Envoie la demande de factures
    this._EnvoieMessageWS(oJSON)

    // attend la réponse
    await this._WaitForAnswer(this.NumeroQuestionEnCours())

    // On a les factures
    log(
      'debug',
      'Réponse reçue pour les documents : ' +
        this.taAnswer[this.NumeroQuestionEnCours()]
    )

    var documents = []

    // Parcours des factures
    var oJSONDocuments = JSON.parse(this.taAnswer[this.NumeroQuestionEnCours()])
    oJSONDocuments = oJSONDocuments.d.b.d

    for (const Reference in oJSONDocuments) {
      if (!oJSONDocuments.hasOwnProperty(Reference)) {
        continue
      }

      var oUnDocument = oJSONDocuments[Reference]

      const pdfStream = new stream.PassThrough()
      const filestream = request(oUnDocument.dlUrl).pipe(pdfStream)
      documents.push({
        title: oUnDocument.name,
        filestream: filestream,
        filename: oUnDocument.name + '.pdf'
      })
    }
    return documents
  }
}

const connector = new eTicketKonnector()

connector.run()
