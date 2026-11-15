pub fn tangent(x: f64) -> f64 {
    scale(x) / 2.0
}

pub fn unused() {}

macro_rules! scaled {
    ($name:ident) => {
        fn $name(x: f64) -> f64 {
            double(x)
        }
    };
}

fn double(x: f64) -> f64 {
    x * 2.0
}

scaled!(scale);

#[cfg(test)]
mod geo_checks {
    fn sample() -> f64 {
        1.0
    }

    #[test]
    fn tangent_is_identity() {
        assert_eq!(super::tangent(sample()), 1.0);
    }
}
