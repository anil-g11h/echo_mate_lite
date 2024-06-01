import { findPosts, insertPost } from '@/api-lib/db';
import { auths } from '@/api-lib/middlewares';
import { getMongoDb } from '@/api-lib/mongodb';
import { ncOpts } from '@/api-lib/nc';
import nc from 'next-connect';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import util from 'util';

const unlinkFile = util.promisify(fs.unlink);

const upload = multer({
  dest: '/tmp',
  limits: { fileSize: 10 * 1024 * 1024 }, // Set file size limit to 5MB
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const handler = nc(ncOpts);

handler.get(async (req, res) => {
  const db = await getMongoDb();

  const posts = await findPosts(
    db,
    req.query.before ? new Date(req.query.before) : undefined,
    req.query.by,
    req.query.limit ? parseInt(req.query.limit, 10) : undefined
  );

  res.json({ posts });
});

handler.post(...auths, upload.single('image'), async (req, res) => {
  if (!req.user) {
    return res.status(401).end();
  }

  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: '"content" is required' });
  }

  let postPicture;
  if (req.file) {
    const fileContent = fs.readFileSync(req.file.path);
    const fileName = `${Date.now()}_${path.basename(req.file.originalname)}`;
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileName,
      Body: fileContent,
      ContentType: req.file.mimetype,
      ACL: 'public-read',
    };

    try {
      await s3.send(new PutObjectCommand(params));
      postPicture = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
    } catch (err) {
      console.error('Error uploading to S3', err);
      res.status(500).json({ error: 'Error uploading file' });
      return;
    }
    // Remove the file from the local filesystem
    await unlinkFile(req.file.path);
  }

  const db = await getMongoDb();

  const post = await insertPost(db, {
    content: req.body.content,
    creatorId: req.user._id,
    ...(postPicture && { image: postPicture }),
  });

  return res.json({ post });
});

export const config = {
  api: {
    bodyParser: false,
  },
};

export default handler;
