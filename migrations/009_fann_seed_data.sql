-- =============================================================
-- Fann — Seed Data
-- 009_fann_seed_data.sql
--
-- Renumbered 002 -> 009 so that plain numeric order is also the correct
-- dependency order. This file inserts into artist_categories, bookings,
-- reviews and notifications, none of which exist until the schema
-- migrations 003-005 have run — so as 002 it failed outright on a fresh
-- database ("relation artist_categories does not exist"), despite the
-- README instructing a numeric-order run. Seed data belongs last.
--
-- (There is deliberately no 002 any more: renumbering the already-applied
-- schema files 003-008 would break databases that have run them.)
--
-- Password for every seeded user: Fann@dev2025
-- Hash below is a real bcrypt hash (cost 12), verified to match:
--   $2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S
-- =============================================================

-- =============================================================
-- USERS
-- =============================================================

INSERT INTO users (id, email, phone, password_hash, role, status, account_code, email_verified_at, phone_verified_at, created_at) VALUES

-- Admin
('00000000-0000-0000-0000-000000000001',
 'admin@fann.app', '+9611234001',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'admin', 'active', 'ADM-000001', NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days'),

-- Artists
('00000000-0000-0000-0000-000000000010',
 'karim.nassar@gmail.com', '+9613001001',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'artist', 'active', 'ART-000001', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days', NOW() - INTERVAL '61 days'),

('00000000-0000-0000-0000-000000000011',
 'layla.khoury@gmail.com', '+9613001002',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'artist', 'active', 'ART-000002', NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days', NOW() - INTERVAL '46 days'),

('00000000-0000-0000-0000-000000000012',
 'marwan.abikhalil@gmail.com', '+9613001003',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'artist', 'active', 'ART-000003', NOW() - INTERVAL '50 days', NOW() - INTERVAL '50 days', NOW() - INTERVAL '51 days'),

('00000000-0000-0000-0000-000000000013',
 'nour.elhage@gmail.com', '+9613001004',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'artist', 'active', 'ART-000004', NOW() - INTERVAL '65 days', NOW() - INTERVAL '65 days', NOW() - INTERVAL '66 days'),

('00000000-0000-0000-0000-000000000014',
 'sara.frem@gmail.com', '+9613001005',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'artist', 'pending_review', 'ART-000005', NOW() - INTERVAL '3 days', NULL, NOW() - INTERVAL '3 days'),

('00000000-0000-0000-0000-000000000015',
 'tony.rizk@hotmail.com', '+9613001006',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'artist', 'suspended', 'ART-000006', NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', NOW() - INTERVAL '41 days'),

-- Planners
('00000000-0000-0000-0000-000000000020',
 'rania.saab@events.lb', '+9613002001',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'planner', 'active', 'PLN-000001', NOW() - INTERVAL '55 days', NOW() - INTERVAL '55 days', NOW() - INTERVAL '56 days'),

('00000000-0000-0000-0000-000000000021',
 'joe.gemayel@luxuryevents.com', '+9613002002',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'planner', 'active', 'PLN-000002', NOW() - INTERVAL '48 days', NOW() - INTERVAL '48 days', NOW() - INTERVAL '49 days'),

('00000000-0000-0000-0000-000000000022',
 'maya.hajj@beirutweddings.com', '+9613002003',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'planner', 'active', 'PLN-000003', NOW() - INTERVAL '70 days', NOW() - INTERVAL '70 days', NOW() - INTERVAL '71 days'),

('00000000-0000-0000-0000-000000000023',
 'fadi.mansour@outlook.com', '+9613002004',
 '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
 'planner', 'pending_review', 'PLN-000004', NOW() - INTERVAL '1 day', NULL, NOW() - INTERVAL '1 day');


-- =============================================================
-- ARTIST PROFILES
-- (no category_id column — categories now via artist_categories)
-- =============================================================

INSERT INTO artist_profiles
  (id, user_id, display_name, bio, location_city, location_country,
   base_price_usd, languages, social_links, is_verified, thumbnail_url, created_at)
VALUES

-- Karim Nassar — DJ
('10000000-0000-0000-0000-000000000010',
 '00000000-0000-0000-0000-000000000010',
 'DJ Karim',
 'Beirut-based DJ with 10 years of experience across clubs, weddings, and festivals. Specialises in commercial house, Arabic pop, and Mediterranean fusion sets. Resident DJ at multiple venues in Mar Mikhael.',
 'Beirut', 'Lebanon',
 300.00,
 '["Arabic","English","French"]',
 '{"instagram":"https://instagram.com/djkarim_lb","tiktok":"https://tiktok.com/@djkarim_lb"}',
 TRUE,
 'https://cdn.fann.app/artists/karim-nassar/primary.jpg',
 NOW() - INTERVAL '60 days'),

-- Layla Khoury — Photographer
('10000000-0000-0000-0000-000000000011',
 '00000000-0000-0000-0000-000000000011',
 'Layla Khoury Photography',
 'Award-winning photographer covering weddings, engagements, and corporate events across Lebanon and the Gulf. Natural light specialist. Editing turnaround: 2 weeks.',
 'Jounieh', 'Lebanon',
 500.00,
 '["Arabic","English"]',
 '{"instagram":"https://instagram.com/laylakhouryphotography","website":"https://laylakhoury.com"}',
 TRUE,
 'https://cdn.fann.app/artists/layla-khoury/primary.jpg',
 NOW() - INTERVAL '45 days'),

-- Marwan Abi Khalil — Live Band
('10000000-0000-0000-0000-000000000012',
 '00000000-0000-0000-0000-000000000012',
 'The Marwan Quartet',
 'Four-piece live band performing Arabic classics, jazz, and contemporary hits. Available as duo, trio, or full quartet. Backline provided. Perfect for upscale weddings and corporate dinners.',
 'Beirut', 'Lebanon',
 800.00,
 '["Arabic","English","French"]',
 '{"instagram":"https://instagram.com/marwanquartet","youtube":"https://youtube.com/@marwanquartet"}',
 TRUE,
 'https://cdn.fann.app/artists/marwan-quartet/primary.jpg',
 NOW() - INTERVAL '50 days'),

-- Nour El Hage — MC / Host
('10000000-0000-0000-0000-000000000013',
 '00000000-0000-0000-0000-000000000013',
 'Nour El Hage — MC',
 'Trilingual MC and event host with 7 years of experience hosting weddings, gala dinners, product launches, and TV segments. Energetic, professional, and always on script.',
 'Dbayeh', 'Lebanon',
 350.00,
 '["Arabic","English","French"]',
 '{"instagram":"https://instagram.com/nourelhage_mc","linkedin":"https://linkedin.com/in/nourelhage"}',
 TRUE,
 'https://cdn.fann.app/artists/nour-el-hage/primary.jpg',
 NOW() - INTERVAL '65 days'),

-- Sara Frem — Dancer (pending review, no thumbnail yet)
('10000000-0000-0000-0000-000000000014',
 '00000000-0000-0000-0000-000000000014',
 'Sara Frem Dance',
 'Contemporary and oriental dancer. Trained in Beirut and Paris. Available for weddings, festivals, and private events.',
 'Baabda', 'Lebanon',
 200.00,
 '["Arabic","French"]',
 '{"instagram":"https://instagram.com/sarafremdance"}',
 FALSE,
 NULL,
 NOW() - INTERVAL '3 days'),

-- Tony Rizk — DJ (suspended)
('10000000-0000-0000-0000-000000000015',
 '00000000-0000-0000-0000-000000000015',
 'DJ Tony R',
 'Club DJ based in Beirut. Available for nightlife and private events.',
 'Beirut', 'Lebanon',
 150.00,
 '["Arabic","English"]',
 '{"instagram":"https://instagram.com/djtony_r"}',
 TRUE,
 'https://cdn.fann.app/artists/tony-rizk/primary.jpg',
 NOW() - INTERVAL '40 days');


-- =============================================================
-- ARTIST CATEGORIES (join table — up to 4 per artist)
-- =============================================================

INSERT INTO artist_categories (artist_profile_id, category_id) VALUES
  ('10000000-0000-0000-0000-000000000010', (SELECT id FROM categories WHERE slug = 'dj')),
  ('10000000-0000-0000-0000-000000000010', (SELECT id FROM categories WHERE slug = 'sound-lighting')),

  ('10000000-0000-0000-0000-000000000011', (SELECT id FROM categories WHERE slug = 'photographer')),
  ('10000000-0000-0000-0000-000000000011', (SELECT id FROM categories WHERE slug = 'videographer')),

  ('10000000-0000-0000-0000-000000000012', (SELECT id FROM categories WHERE slug = 'band-group')),

  ('10000000-0000-0000-0000-000000000013', (SELECT id FROM categories WHERE slug = 'mc-host')),
  ('10000000-0000-0000-0000-000000000013', (SELECT id FROM categories WHERE slug = 'stand-up-comedian')),

  ('10000000-0000-0000-0000-000000000014', (SELECT id FROM categories WHERE slug = 'dancer-dance-group')),

  ('10000000-0000-0000-0000-000000000015', (SELECT id FROM categories WHERE slug = 'dj'));


-- =============================================================
-- PLANNER PROFILES
-- =============================================================

INSERT INTO planner_profiles
  (id, user_id, display_name, company_name, bio, location_city, location_country,
   event_types, social_links, thumbnail_url, created_at)
VALUES

('20000000-0000-0000-0000-000000000020',
 '00000000-0000-0000-0000-000000000020',
 'Rania Saab', 'Saab Events',
 'Full-service event planning company based in Beirut. 12 years of experience in weddings, corporate events, and private celebrations. Strong vendor network across Lebanon.',
 'Beirut', 'Lebanon',
 '["Wedding","Corporate","Private Party"]',
 '{"instagram":"https://instagram.com/saabeventslb","website":"https://saabeventslb.com"}',
 'https://cdn.fann.app/planners/rania-saab/primary.jpg',
 NOW() - INTERVAL '55 days'),

('20000000-0000-0000-0000-000000000021',
 '00000000-0000-0000-0000-000000000021',
 'Joe Gemayel', 'Luxe Moments Lebanon',
 'Luxury event designer specialising in ultra-premium weddings and gala dinners. Based in Beirut, operating across Lebanon and the Gulf.',
 'Beirut', 'Lebanon',
 '["Wedding","Gala Dinner","Product Launch"]',
 '{"instagram":"https://instagram.com/luxemomentslb","website":"https://luxemomentslb.com"}',
 'https://cdn.fann.app/planners/joe-gemayel/primary.jpg',
 NOW() - INTERVAL '48 days'),

('20000000-0000-0000-0000-000000000022',
 '00000000-0000-0000-0000-000000000022',
 'Maya Hajj', 'Beirut Weddings Co.',
 'Wedding specialist with a focus on outdoor and venue weddings in the greater Beirut area. Known for floral-forward, intimate designs.',
 'Hamra', 'Lebanon',
 '["Wedding","Engagement Party","Bridal Shower"]',
 '{"instagram":"https://instagram.com/beirutweddingsco"}',
 'https://cdn.fann.app/planners/maya-hajj/primary.jpg',
 NOW() - INTERVAL '70 days'),

-- Fadi Mansour — pending, no thumbnail
('20000000-0000-0000-0000-000000000023',
 '00000000-0000-0000-0000-000000000023',
 'Fadi Mansour', NULL,
 'Freelance event organiser, mainly corporate.',
 'Tripoli', 'Lebanon',
 '["Corporate","Conference"]',
 '{}',
 NULL,
 NOW() - INTERVAL '1 day');


-- =============================================================
-- MEDIA
-- =============================================================

INSERT INTO media
  (id, user_id, media_type, s3_key, cdn_url, file_size_bytes, duration_sec, is_primary, sort_order, created_at)
VALUES

-- Karim — primary photo + 2 extras + 1 video
('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010',
 'photo', 'artists/karim-nassar/primary.jpg', 'https://cdn.fann.app/artists/karim-nassar/primary.jpg',
 4718592, NULL, TRUE, 0, NOW() - INTERVAL '59 days'),
('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000010',
 'photo', 'artists/karim-nassar/set-1.jpg', 'https://cdn.fann.app/artists/karim-nassar/set-1.jpg',
 3670016, NULL, FALSE, 1, NOW() - INTERVAL '59 days'),
('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000010',
 'photo', 'artists/karim-nassar/set-2.jpg', 'https://cdn.fann.app/artists/karim-nassar/set-2.jpg',
 5242880, NULL, FALSE, 2, NOW() - INTERVAL '58 days'),
('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000010',
 'video', 'artists/karim-nassar/showreel.mp4', 'https://cdn.fann.app/artists/karim-nassar/showreel.mp4',
 157286400, 58, FALSE, 3, NOW() - INTERVAL '57 days'),

-- Layla — primary photo + 2 portfolio shots
('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000011',
 'photo', 'artists/layla-khoury/primary.jpg', 'https://cdn.fann.app/artists/layla-khoury/primary.jpg',
 6291456, NULL, TRUE, 0, NOW() - INTERVAL '44 days'),
('30000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000011',
 'photo', 'artists/layla-khoury/portfolio-1.jpg', 'https://cdn.fann.app/artists/layla-khoury/portfolio-1.jpg',
 7340032, NULL, FALSE, 1, NOW() - INTERVAL '44 days'),
('30000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000011',
 'photo', 'artists/layla-khoury/portfolio-2.jpg', 'https://cdn.fann.app/artists/layla-khoury/portfolio-2.jpg',
 6815744, NULL, FALSE, 2, NOW() - INTERVAL '43 days'),

-- Marwan — primary photo + 1 video
('30000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000012',
 'photo', 'artists/marwan-quartet/primary.jpg', 'https://cdn.fann.app/artists/marwan-quartet/primary.jpg',
 5767168, NULL, TRUE, 0, NOW() - INTERVAL '49 days'),
('30000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000012',
 'video', 'artists/marwan-quartet/live-set.mp4', 'https://cdn.fann.app/artists/marwan-quartet/live-set.mp4',
 183500800, 60, FALSE, 1, NOW() - INTERVAL '48 days'),

-- Nour — primary photo
('30000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000013',
 'photo', 'artists/nour-el-hage/primary.jpg', 'https://cdn.fann.app/artists/nour-el-hage/primary.jpg',
 4194304, NULL, TRUE, 0, NOW() - INTERVAL '64 days'),

-- Tony — one photo only
('30000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000015',
 'photo', 'artists/tony-rizk/primary.jpg', 'https://cdn.fann.app/artists/tony-rizk/primary.jpg',
 2621440, NULL, TRUE, 0, NOW() - INTERVAL '40 days');

-- Sara has no media yet — intentional, reflects a fresh pending_review state


-- =============================================================
-- ID DOCUMENTS
-- =============================================================

INSERT INTO id_documents (id, user_id, s3_key, status, rejection_reason, reviewed_by, reviewed_at, uploaded_at) VALUES
('40000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010',
 'id-docs/karim-nassar.jpg', 'approved', NULL,
 '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '60 days', NOW() - INTERVAL '61 days'),
('40000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011',
 'id-docs/layla-khoury.jpg', 'approved', NULL,
 '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '45 days', NOW() - INTERVAL '46 days'),
('40000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000012',
 'id-docs/marwan-abikhalil.jpg', 'approved', NULL,
 '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '50 days', NOW() - INTERVAL '51 days'),
('40000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000013',
 'id-docs/nour-elhage.jpg', 'approved', NULL,
 '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '65 days', NOW() - INTERVAL '66 days'),
('40000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000015',
 'id-docs/tony-rizk.jpg', 'approved', NULL,
 '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '40 days', NOW() - INTERVAL '41 days'),

-- Sara — pending, sitting in the admin review queue right now
('40000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000014',
 'id-docs/sara-frem.jpg', 'pending', NULL, NULL, NULL, NOW() - INTERVAL '3 days');


-- =============================================================
-- AVAILABILITY BLOCKS
-- =============================================================

INSERT INTO availability_blocks (id, artist_id, start_date, end_date, note, created_at) VALUES
('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010',
 CURRENT_DATE + INTERVAL '20 days', CURRENT_DATE + INTERVAL '22 days',
 'Booked — private festival set', NOW() - INTERVAL '10 days'),
('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000012',
 CURRENT_DATE + INTERVAL '5 days', CURRENT_DATE + INTERVAL '5 days',
 'Out of town — family event', NOW() - INTERVAL '8 days');


-- =============================================================
-- CONVERSATIONS + MESSAGES
-- =============================================================

INSERT INTO conversations (id, artist_id, planner_id, last_message_at, created_at) VALUES
-- Rania <-> Karim — mid-negotiation, upcoming booking
('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
 NOW() - INTERVAL '9 days', NOW() - INTERVAL '11 days'),
-- Maya <-> Layla — quote sent, unread
('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000022',
 NOW() - INTERVAL '2 days', NOW() - INTERVAL '4 days'),
-- Joe <-> Marwan — completed booking, thread wrapped up
('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000021',
 NOW() - INTERVAL '38 days', NOW() - INTERVAL '42 days');

INSERT INTO messages (conversation_id, sender_id, body, read_at, created_at) VALUES
('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000020',
 'Hi Karim, we''re looking for a DJ for a private event on the 20th, around 4 hours. Does that work?',
 NOW() - INTERVAL '10 days', NOW() - INTERVAL '11 days'),
('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010',
 'Hi Rania, that works for me. My rate for 4 hours would be around $600 including basic sound setup.',
 NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),
('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000020',
 'Sounds good, let''s go ahead and lock it in.',
 NULL, NOW() - INTERVAL '9 days'),

('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000022',
 'Hi Layla, loved your portfolio! Could you send a quote for a full wedding day, 8 hours coverage?',
 NOW() - INTERVAL '3 days', NOW() - INTERVAL '4 days'),
('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000011',
 'Hi Maya, thank you! For 8 hours of full-day coverage with edited gallery delivery in 2 weeks, it''s $1,800.',
 NULL, NOW() - INTERVAL '2 days'),

('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000021',
 'Hi Marwan, the quartet was fantastic at our gala last week. Thank you again!',
 NOW() - INTERVAL '38 days', NOW() - INTERVAL '38 days'),
('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000012',
 'Thank you Joe, it was a pleasure — hope to work together again soon.',
 NOW() - INTERVAL '37 days', NOW() - INTERVAL '38 days');


-- =============================================================
-- BOOKINGS
-- Four states demonstrated: upcoming/accepted, completed with a
-- review still pending (anonymity gate active), completed with
-- both reviews visible, and declined.
-- =============================================================

INSERT INTO bookings
  (id, artist_id, planner_id, conversation_id, event_name, event_date, event_location,
   duration_hours, agreed_fee_usd, notes, status,
   artist_accepted_at, planner_accepted_at,
   cancelled_by, cancelled_at, cancellation_note,
   review_emails_sent_at, created_at)
VALUES

-- 1. Rania + Karim — accepted, event is still upcoming
('70000000-0000-0000-0000-000000000001',
 '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
 '60000000-0000-0000-0000-000000000001',
 'Saab Family Private Event', CURRENT_DATE + INTERVAL '20 days', 'Beirut, Lebanon',
 4.0, 600.00, 'Private event, basic sound setup included.', 'accepted',
 NOW() - INTERVAL '10 days', NOW() - INTERVAL '11 days',
 NULL, NULL, NULL,
 NULL, NOW() - INTERVAL '11 days'),

-- 2. Joe + Marwan — completed, planner already reviewed, waiting on artist
--    (still within the 7-day window — demonstrates the anonymity gate)
('70000000-0000-0000-0000-000000000002',
 '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000021',
 '60000000-0000-0000-0000-000000000003',
 'Gemayel Corporate Gala', CURRENT_DATE - INTERVAL '5 days', 'Phoenicia Hotel, Beirut',
 3.0, 800.00, 'Full quartet, gala dinner background + 1 live set.', 'completed',
 NOW() - INTERVAL '39 days', NOW() - INTERVAL '40 days',
 NULL, NULL, NULL,
 NOW() - INTERVAL '4 days', NOW() - INTERVAL '40 days'),

-- 3. Maya + Nour — completed further back, both sides reviewed and visible
('70000000-0000-0000-0000-000000000003',
 '00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000022',
 NULL,
 'Hajj-Khoury Wedding', CURRENT_DATE - INTERVAL '30 days', 'Le Royal, Dbayeh',
 6.0, 350.00, 'MC for full wedding reception.', 'completed',
 NOW() - INTERVAL '61 days', NOW() - INTERVAL '62 days',
 NULL, NULL, NULL,
 NOW() - INTERVAL '29 days', NOW() - INTERVAL '62 days'),

-- 4. Rania + Tony — declined before Tony was suspended
('70000000-0000-0000-0000-000000000004',
 '00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000020',
 NULL,
 'Corporate Launch Party', CURRENT_DATE + INTERVAL '2 days', 'Beirut, Lebanon',
 3.0, 400.00, 'Requested a club-style DJ set.', 'declined',
 NULL, NOW() - INTERVAL '42 days',
 NULL, NULL, NULL,
 NULL, NOW() - INTERVAL '42 days');


-- =============================================================
-- REVIEWS
-- =============================================================

-- Booking 2 (Joe + Marwan) — planner submitted, artist hasn't yet.
-- is_visible = FALSE: hidden until Marwan submits or the 7-day window
-- (from review_emails_sent_at, 4 days ago) expires.
INSERT INTO reviews
  (booking_id, reviewer_id, reviewee_id, reviewer_role,
   overall_score, score_communication, score_professionalism, score_punctuality, score_quality,
   body, is_visible, submitted_at)
VALUES
('70000000-0000-0000-0000-000000000002',
 '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000012',
 'planner',
 5, 5, 5, 5, 5,
 'The quartet was fantastic — professional, on time, and the crowd loved the set. Would book again.',
 FALSE, NOW() - INTERVAL '3 days');

-- Booking 3 (Maya + Nour) — both sides submitted, mutual reveal triggered
INSERT INTO reviews
  (booking_id, reviewer_id, reviewee_id, reviewer_role,
   overall_score, score_communication, score_professionalism, score_punctuality, score_quality,
   body, is_visible, submitted_at)
VALUES
('70000000-0000-0000-0000-000000000003',
 '00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000013',
 'planner',
 5, 5, 5, 5, 5,
 'Nour kept the entire reception on schedule and the guests were engaged all night. Highly recommend.',
 TRUE, NOW() - INTERVAL '28 days'),
('70000000-0000-0000-0000-000000000003',
 '00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000022',
 'artist',
 4, 4, 5, 4, 4,
 'Well-organised event, clear run sheet provided in advance. Minor delay on the first dance timing.',
 TRUE, NOW() - INTERVAL '27 days');

-- Aggregate rating columns — normally recalculated by reviews.service.ts
-- when a review becomes visible. Set directly here since seed data
-- bypasses the service layer.
UPDATE artist_profiles  SET avg_rating = 5.00, review_count = 1 WHERE id = '10000000-0000-0000-0000-000000000013'; -- Nour
UPDATE planner_profiles SET avg_rating = 4.00, review_count = 1 WHERE id = '20000000-0000-0000-0000-000000000022'; -- Maya


-- =============================================================
-- NOTIFICATIONS
-- =============================================================

INSERT INTO notifications (user_id, type, title, body, data, read_at, created_at) VALUES
-- Booking 1 — Karim accepted Rania's booking
('00000000-0000-0000-0000-000000000020', 'booking_accepted', 'Karim accepted your booking',
 'DJ Karim confirmed the Saab Family Private Event.',
 '{"booking_id":"70000000-0000-0000-0000-000000000001"}',
 NOW() - INTERVAL '9 days', NOW() - INTERVAL '10 days'),

-- Booking 2 — review requests sent to both sides, 4 days ago
('00000000-0000-0000-0000-000000000021', 'review_request', 'How was your booking?',
 'Tell us how the Gemayel Corporate Gala went.',
 '{"booking_id":"70000000-0000-0000-0000-000000000002"}',
 NOW() - INTERVAL '3 days', NOW() - INTERVAL '4 days'),
('00000000-0000-0000-0000-000000000012', 'review_request', 'How was your booking?',
 'Tell us how the Gemayel Corporate Gala went.',
 '{"booking_id":"70000000-0000-0000-0000-000000000002"}',
 NULL, NOW() - INTERVAL '4 days'),

-- Booking 3 — both reviews now published
('00000000-0000-0000-0000-000000000013', 'review_published', 'Your review is live',
 'Maya''s review of your work on the Hajj-Khoury Wedding is now visible on your profile.',
 '{"booking_id":"70000000-0000-0000-0000-000000000003"}',
 NULL, NOW() - INTERVAL '27 days'),
('00000000-0000-0000-0000-000000000022', 'review_published', 'Your review is live',
 'Nour''s review of the Hajj-Khoury Wedding is now visible on your profile.',
 '{"booking_id":"70000000-0000-0000-0000-000000000003"}',
 NOW() - INTERVAL '26 days', NOW() - INTERVAL '27 days'),

-- Booking 4 — Tony declined
('00000000-0000-0000-0000-000000000020', 'booking_declined', 'Tony declined your booking',
 'DJ Tony R was unable to take the Corporate Launch Party.',
 '{"booking_id":"70000000-0000-0000-0000-000000000004"}',
 NOW() - INTERVAL '41 days', NOW() - INTERVAL '42 days');


-- =============================================================
-- PAYMENTS (annual membership — confirmed manually by admin,
-- no payment processor; see admin.service.ts reviewPayment())
-- =============================================================

INSERT INTO payments
  (id, planner_id, amount_usd, transfer_service, reference_code,
   period_start, period_end, status, confirmed_by, confirmed_at, created_at)
VALUES
('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000020',
 99.00, 'OMT', 'OMT-2025-448831',
 CURRENT_DATE - INTERVAL '56 days', CURRENT_DATE + INTERVAL '309 days',
 'confirmed', '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '54 days', NOW() - INTERVAL '56 days'),

('80000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000021',
 99.00, 'Wish', 'WSH-887712',
 CURRENT_DATE - INTERVAL '49 days', CURRENT_DATE + INTERVAL '316 days',
 'confirmed', '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '48 days', NOW() - INTERVAL '49 days'),

('80000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000022',
 99.00, 'WesternUnion', 'WU-339920-LB',
 CURRENT_DATE - INTERVAL '71 days', CURRENT_DATE + INTERVAL '294 days',
 'confirmed', '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '69 days', NOW() - INTERVAL '71 days'),

-- Fadi — pending, sitting in the admin queue right now
('80000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000023',
 99.00, 'OMT', 'OMT-2026-001122',
 CURRENT_DATE, CURRENT_DATE + INTERVAL '365 days',
 'pending', NULL, NULL, NOW() - INTERVAL '1 day');


-- =============================================================
-- FLAGS
-- =============================================================

INSERT INTO flags
  (id, flagged_by, target_type, target_id, reason, status, resolved_by, resolved_at, resolver_note, created_at)
VALUES
('90000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000020',
 'profile', '00000000-0000-0000-0000-000000000015',
 'Artist contacted me outside the platform and made an inappropriate payment request.',
 'actioned', '00000000-0000-0000-0000-000000000001', NOW() - INTERVAL '38 days',
 'Account suspended pending further review.', NOW() - INTERVAL '39 days');


-- =============================================================
-- AUDIT LOG
-- =============================================================

INSERT INTO audit_log (admin_id, action, target_id, note, metadata, created_at) VALUES
('00000000-0000-0000-0000-000000000001', 'user.suspended', '00000000-0000-0000-0000-000000000015',
 'Off-platform solicitation reported by planner. Suspended pending review.',
 '{"flag_id":"90000000-0000-0000-0000-000000000001"}', NOW() - INTERVAL '38 days'),

('00000000-0000-0000-0000-000000000001', 'flag.actioned', '00000000-0000-0000-0000-000000000015',
 'Account suspended.', '{"flag_id":"90000000-0000-0000-0000-000000000001"}', NOW() - INTERVAL '38 days'),

('00000000-0000-0000-0000-000000000001', 'payment.confirmed', '00000000-0000-0000-0000-000000000020',
 NULL, '{"payment_id":"80000000-0000-0000-0000-000000000001","transfer_service":"OMT","reference":"OMT-2025-448831"}',
 NOW() - INTERVAL '54 days'),

('00000000-0000-0000-0000-000000000001', 'payment.confirmed', '00000000-0000-0000-0000-000000000021',
 NULL, '{"payment_id":"80000000-0000-0000-0000-000000000002","transfer_service":"Wish","reference":"WSH-887712"}',
 NOW() - INTERVAL '48 days'),

('00000000-0000-0000-0000-000000000001', 'payment.confirmed', '00000000-0000-0000-0000-000000000022',
 NULL, '{"payment_id":"80000000-0000-0000-0000-000000000003","transfer_service":"WesternUnion","reference":"WU-339920-LB"}',
 NOW() - INTERVAL '69 days');

-- =============================================================
-- END OF SEED
-- =============================================================
