import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { config } from "./config";
import { prisma } from "./db";

if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    callbackURL: config.GOOGLE_CALLBACK_URL
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(new Error("Google did not return an email address"));
      const user = await prisma.user.upsert({
        where: { googleId: profile.id },
        update: {
          email,
          name: profile.displayName || email,
          avatar: profile.photos?.[0]?.value ?? null
        },
        create: {
          googleId: profile.id,
          email,
          name: profile.displayName || email,
          avatar: profile.photos?.[0]?.value ?? null
        }
      });
      done(null, { id: user.id });
    } catch (error) {
      done(error as Error);
    }
  }));
}

passport.serializeUser((user, done) => {
  done(null, (user as Express.User).id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user ? { id: user.id } : false);
  } catch (error) {
    done(error as Error);
  }
});

declare global {
  namespace Express {
    interface User { id: string }
  }
}
