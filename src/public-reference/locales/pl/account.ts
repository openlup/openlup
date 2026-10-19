const account = {
  reference: {
  "writeFailed": "Zmiana daty odnowienia została odrzucona lub niepotwierdzona. Konto pokazuje ostatni znany stan.",
  "readFailed": "Zgłoszono zmianę, ale nie udało się odczytać konta. Odśwież je przed sprawdzeniem daty.",
  "saved": "Zapisano datę odnowienia i odświeżono konto.",
  "refreshed": "Odświeżono stan konta.",
  "refreshFailed": "Nie udało się potwierdzić aktualnego stanu konta. Jeśli sesja wygasła, zaloguj się ponownie.",
  "loading": "Wczytywanie konta…",
  "unavailable": "Nie udało się odczytać konta. Sesja mogła wygasnąć. Jeśli ponowna próba nie pomoże, wyloguj się i poproś ponownie o logowanie.",
  "refresh": "Odśwież konto",
  "orders": "Zamówienia",
  "noOrders": "Nie widać jeszcze zamówień.",
  "subscriptions": "Subskrypcje",
  "choose": "Wybierz subskrypcję",
  "status": "Status: {{status}}",
  "next": "Planowane odnowienie i płatność: {{date}}. To nie jest obietnica daty dostawy.",
  "notScheduled": "nie zaplanowano",
  "cadence": "Cykl: co {{days}} dni.",
  "change": "Zmień datę kolejnego odnowienia",
  "blocked": "Obecnie nie można zmienić daty tej subskrypcji.",
  "noSubscriptions": "Nie widać jeszcze subskrypcji. Dokończ zakup lub odśwież konto.",
  "return": "Wróć do zamówienia cyklicznego",
  "payment": "płatność",
  "unknown": "nieznany"
},
  "accountTitle": "Twoje zamówienia cykliczne",
  "signOut": "Wyloguj się",
  "login": {
    "title": "Zaloguj się do konta",
    "email": "E-mail",
    "emailInvalid": "Wpisz poprawny adres e-mail.",
    "send": "Poproś o logowanie",
    "sending": "Wysyłanie…",
    "accepted": "Jeśli ten adres może się zalogować, poproszono o instrukcje logowania. Sprawdź skrzynkę i użyj linku lub kodu. To nie potwierdza istnienia konta ani dostarczenia wiadomości.",
    "acceptedOpaque": "Jeśli ten adres może się zalogować, poproszono o token logowania. Wklej cały token z wiadomości. To nie potwierdza istnienia konta ani dostarczenia wiadomości.",
    "requestAgain": "Poproś ponownie",
    "changeAddress": "Użyj innego adresu",
    "fallback": "Wpisz kod z wiadomości",
    "code": "Kod logowania",
    "numericPlaceholder": "6–8 cyfr",
    "opaquePlaceholder": "Pełny token logowania",
    "verify": "Sprawdź kod",
    "verifying": "Sprawdzanie…",
    "codeInvalidFormat": "Wpisz kod w wymaganym formacie.",
    "codeError": "Nie udało się sprawdzić kodu. Poproś o nowy.",
    "sendError": "Logowanie jest niedostępne. Spróbuj później.",
    "returning": "Logowano się już w tej przeglądarce.",
    "forget": "Usuń tę wskazówkę",
    "account": "Otwórz konto",
    "social": {
      "continue": "Kontynuuj przez {{provider}}",
      "error": "Nie udało się rozpocząć logowania zewnętrznego."
    }
  },
  "callback": {
    "title": "Logowanie do konta",
    "loading": "Sprawdzanie logowania…",
    "succeeded": "Logowanie potwierdzone. Otwieranie konta…",
    "callback_invalid": "Link logowania jest nieprawidłowy. Poproś o nowy.",
    "callback_expired": "Link logowania wygasł. Poproś o nowy.",
    "timeout": "Przekroczono czas sprawdzania. Poproś ponownie o logowanie.",
    "transport_uncertain": "Nie udało się potwierdzić wyniku. Spróbuj ponownie.",
    "failed": "Nie udało się zakończyć logowania.",
    "unknown": "Logowanie jest niekompletne. Poproś ponownie o logowanie.",
    "accountUnavailable": "Powiązane konto jest niedostępne. Wyloguj się i spróbuj ponownie.",
    "retry": "Poproś ponownie o logowanie"
  },
  "dashboard": {
    "subscriptionV2": {
      "holidayNote": "Dzień wolny może przesunąć ten szacunek.",
      "modals": {
        "reschedule": {
          "title": "Zmień datę kolejnego odnowienia",
          "description": "Wybierz datę odnowienia i płatności między {{from}} a {{to}}. Termin dostawy jest szacunkowy.",
          "summaryTitle": "Przed potwierdzeniem",
          "renewalAndCharge": "Planowane odnowienie i płatność: {{date}}",
          "estimatedDelivery": "Szacowane okno dostawy, bez gwarancji: {{window}}",
          "futureCadence": "Kolejne odnowienia co {{days}} dni po {{date}}.",
          "protectedAlignment": "Niedostarczona przesyłka może przesunąć cykl później, nigdy wcześniej.",
          "confirm": "Potwierdź datę odnowienia",
          "noDates": "Brak dostępnych dat odnowienia.",
          "impact": "Zmienia datę odnowienia i płatności. Nie gwarantuje daty dostawy.",
          "gridLabel": "Wybierz datę odnowienia i płatności",
          "current": "Obecna data",
          "inDays": "Za {{days}} dni"
        }
      }
    }
  }
};
export default account;
