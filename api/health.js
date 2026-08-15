module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    hasPaystackSecret: !!process.env.PAYSTACK_SECRET_KEY,
    hasSupabaseService: !!process.env.SUPABASE_SERVICE_ROLE_KEY
  });
};
