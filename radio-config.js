/* ============================================================
   RADIO OACV — adresse du serveur de radio

   Ce fichier est le SEUL endroit à modifier pour brancher le site
   sur un serveur de radio. Il est versionné avec le site, et ne
   contient aucun secret : ce sont des adresses publiques.

   window.RADIO_API doit pointer vers le serveur qui diffuse la radio.
   Exemples :
     window.RADIO_API = 'https://radio.oacv.fr';    // domaine à toi
     window.RADIO_API = 'http://12.34.56.78:8123';   // adresse IP brute
     window.RADIO_API = '';                          // même origine

   Si le site et le serveur sont sur la même machine (en local),
   laisse vide : le site.listenerra le serveur tout seul.
   ============================================================ */

window.RADIO_API = '';
