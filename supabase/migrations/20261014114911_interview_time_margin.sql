-- Le chrono client se met en pause pendant que le recruteur prépare sa question :
-- la durée réelle d'un entretien de 5 min dépasse donc 300 s. Marge serveur portée à 7 min.
update public.app_settings set value = '420' where key = 'interview_max_seconds';
