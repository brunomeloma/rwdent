-- Achado em pentest: o upload da galeria de fotos (radiografias, fotos
-- clínicas, antes/depois) só checava o tipo do arquivo no navegador
-- (app.js: `file.type.startsWith('image/')`). Esse tipo é uma informação
-- que o próprio navegador manda e é trivial de forjar — quem chamasse a
-- API do Supabase Storage direto (pulando a tela do app) podia subir
-- qualquer arquivo disfarçado de imagem, porque o bucket "galeria" não
-- tinha nenhuma restrição de tipo do lado do servidor.
--
-- Impacto era limitado (bucket é privado, e os arquivos ficam servidos
-- num domínio separado do site — supabase.co — então não dava pra roubar
-- sessão do app assim), mas mesmo assim vale travar direito: agora o
-- bucket só aceita os formatos de imagem realmente usados pela galeria,
-- reforçando o que o app já tenta fazer no navegador.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif']
WHERE id = 'galeria';
